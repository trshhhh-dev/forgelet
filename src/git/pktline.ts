// pkt-line framing, the envelope every git protocol message travels in.  A packet is four ASCII
// hex digits of total length (header included) followed by its payload; 0000, 0001 and 0002 are the
// length-less control packets (flush, delim, response-end).  The maximum total length is git's
// LARGE_PACKET_MAX, 65520 bytes, so a payload is at most 65516 bytes.
//
// Requests are read from a fully buffered HTTP body, so the decoder here is a straightforward
// cursor; the streaming decoder on the client side is not needed by a server.  Two entry points
// matter: decodePktLines() for a body that is all packets (fetch, ls-refs), and readPktLineSection()
// for a body where raw bytes follow the command section (receive-pack's packfile).

export const PKT_LINE_MAX = 65_520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type PktLineControl = 'flush' | 'delim' | 'response-end';

export interface DataPacket {
  readonly kind: 'data';
  readonly payload: Buffer;
}

export interface ControlPacket {
  readonly kind: PktLineControl;
}

export type PktLinePacket = DataPacket | ControlPacket;

export class PktLineError extends Error {
  readonly code: string;

  constructor(message: string, code = 'pktline') {
    super(message);
    this.name = 'PktLineError';
    this.code = code;
  }
}

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new PktLineError(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`, 'pktline-too-long');
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function flushPacket(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPacket(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function responseEndPacket(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode packet payloads and controls in order; the three control strings are recognised. */
export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | PktLineControl>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(flushPacket());
    else if (item === 'delim') parts.push(delimPacket());
    else if (item === 'response-end') parts.push(responseEndPacket());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

function controlOf(length: number): PktLineControl | null {
  if (length === 0) return 'flush';
  if (length === 1) return 'delim';
  if (length === 2) return 'response-end';
  return null;
}

/**
 * Read one packet at `offset`.  Returns the packet and the offset just past it, or null when the
 * buffer ended cleanly at a packet boundary.
 */
function readOne(buffer: Buffer, offset: number): { packet: PktLinePacket; next: number } | null {
  if (offset === buffer.length) return null;
  if (offset + 4 > buffer.length) throw new PktLineError('pkt-line header is truncated', 'pktline-truncated');
  const text = buffer.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(text)) {
    throw new PktLineError(`pkt-line header ${JSON.stringify(text)} is not four hex digits`, 'pktline-header');
  }
  const length = Number.parseInt(text, 16);
  const control = controlOf(length);
  if (control !== null) return { packet: { kind: control }, next: offset + 4 };
  if (length < 4) throw new PktLineError(`pkt-line length ${length} is invalid`, 'pktline-length');
  if (offset + length > buffer.length) {
    throw new PktLineError(`pkt-line at ${offset} declares ${length} bytes but ${buffer.length - offset} remain`, 'pktline-truncated');
  }
  return {
    packet: { kind: 'data', payload: buffer.subarray(offset + 4, offset + length) },
    next: offset + length,
  };
}

/**
 * Decode a body made only of packets.  A truncated or malformed packet throws; trailing raw bytes
 * are an error unless `allowTrailing` is set (receive-pack uses the section reader instead).
 */
export function decodePktLines(buffer: Buffer): PktLinePacket[] {
  const packets: PktLinePacket[] = [];
  let offset = 0;
  for (;;) {
    const read = readOne(buffer, offset);
    if (read === null) break;
    packets.push(read.packet);
    offset = read.next;
  }
  return packets;
}

/**
 * Read the packet section of a receive-pack body: every data packet up to and including the first
 * control packet.  The bytes after that control are the packfile and are returned as `rest`.
 */
export function readPktLineSection(buffer: Buffer, start = 0): {
  packets: PktLinePacket[];
  control: PktLineControl | null;
  next: number;
} {
  const packets: PktLinePacket[] = [];
  let offset = start;
  for (;;) {
    const read = readOne(buffer, offset);
    if (read === null) return { packets, control: null, next: offset };
    packets.push(read.packet);
    offset = read.next;
    if (read.packet.kind !== 'data') return { packets, control: read.packet.kind, next: offset };
  }
}

/** The text of every data packet, newlines intact. */
export function packetLines(packets: readonly PktLinePacket[]): string[] {
  return packets
    .filter((packet): packet is DataPacket => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8'));
}

/**
 * Frame sideband data.  Band 1 is pack data, band 2 progress, band 3 a fatal error.  A single data
 * run longer than one pkt-line is split; each packet is one band byte plus at most 65515 data bytes.
 */
export function sidebandPackets(band: 1 | 2 | 3, data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(sidebandLength(data.length));
  writeSidebandPackets(out, 0, band, data);
  return out;
}

/** Exact byte length of `sidebandPackets(band, data)`. */
export function sidebandLength(dataLength: number): number {
  const chunk = PKT_LINE_MAX_PAYLOAD - 1;
  const packets = Math.max(1, Math.ceil(dataLength / chunk));
  return dataLength + packets * 5;
}

const HEX_DIGITS = '0123456789abcdef';

/** Write a four-digit lowercase hex pkt-line length; the caller guarantees `length <= 65520`. */
export function writePktHeader(out: Buffer, offset: number, length: number): void {
  out[offset] = HEX_DIGITS.charCodeAt((length >>> 12) & 0x0f);
  out[offset + 1] = HEX_DIGITS.charCodeAt((length >>> 8) & 0x0f);
  out[offset + 2] = HEX_DIGITS.charCodeAt((length >>> 4) & 0x0f);
  out[offset + 3] = HEX_DIGITS.charCodeAt(length & 0x0f);
}

/** Write sideband packets straight into `out`, avoiding the intermediate payload and concat copies. */
export function writeSidebandPackets(out: Buffer, offset: number, band: 1 | 2 | 3, data: Uint8Array): number {
  let source = 0;
  let at = offset;
  do {
    const take = Math.min(PKT_LINE_MAX_PAYLOAD - 1, data.length - source);
    const length = take + 5;
    writePktHeader(out, at, length);
    out[at + 4] = band;
    out.set(data.subarray(source, source + take), at + 5);
    at += length;
    source += take;
  } while (source < data.length);
  return at - offset;
}
