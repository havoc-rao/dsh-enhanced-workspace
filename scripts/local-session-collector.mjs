// Temporary loopback-only OTLP capture. No upstream forwarding or content logging.
import { createServer } from 'node:http'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const port = Number(process.env.LOCAL_OTLP_PORT ?? 24318)
const output = resolve(process.env.LOCAL_OTLP_DIR ?? 'tmp/session-observation')
await mkdir(output, { recursive: true, mode: 0o700 })
let sequence = 0
const MAX_BODY = 8 * 1024 * 1024
// OTLP protobuf wire fields, preserving fixed64 timestamps and numeric values.
function fields(bytes) {
  let at = 0
  const result = new Map()
  const varint = () => {
    let value = 0n, shift = 0n
    while (at < bytes.length && shift <= 63n) {
      const byte = bytes[at++]; value |= BigInt(byte & 127) << shift
      if (!(byte & 128)) return value
      shift += 7n
    }
    throw new Error('Invalid protobuf varint')
  }
  while (at < bytes.length) {
    const tag = Number(varint()), key = tag >>> 3, wire = tag & 7
    let value
    if (wire === 0) value = varint()
    else if (wire === 1) { value = bytes.subarray(at, at + 8); at += 8 }
    else if (wire === 2) { const length = Number(varint()); value = bytes.subarray(at, at + length); at += length }
    else if (wire === 5) { value = bytes.subarray(at, at + 4); at += 4 }
    else throw new Error('Unsupported protobuf wire type')
    if (at > bytes.length || key === 0) throw new Error('Invalid protobuf field')
    result.set(key, [...(result.get(key) ?? []), value])
  }
  return result
}
const list = (f, key) => f.get(key) ?? []
const messages = (f, key) => list(f, key).map(fields)
const text = (f, key) => list(f, key)[0]?.toString('utf8') ?? ''
const hex = (f, key) => list(f, key)[0]?.toString('hex') ?? ''
const uint64 = (f, key) => list(f, key)[0]?.readBigUInt64LE() ?? 0n
function attributes(f, key) {
  return Object.fromEntries(messages(f, key).map(row => {
    const value = messages(row, 2)[0] ?? new Map()
    return [text(row, 1), value.has(1) ? text(value, 1) : value.has(2) ? list(value, 2)[0] === 1n : value.has(3) ? String(list(value, 3)[0]) : '']
  }))
}
function decodeTraces(bytes) {
  return messages(fields(bytes), 1).flatMap(resource => messages(resource, 2).flatMap(scope => messages(scope, 2).map(span => {
    const start = uint64(span, 7), end = uint64(span, 8)
    return { name: text(span, 5), traceId: hex(span, 1), spanId: hex(span, 2), parentSpanId: hex(span, 4),
      startUnixNano: String(start), endUnixNano: String(end), durationMs: Number(end - start) / 1e6,
      attributes: attributes(span, 9), resource: attributes(messages(resource, 1)[0] ?? new Map(), 1),
      eventCount: messages(span, 11).length, linkCount: messages(span, 13).length,
      statusMessage: text(messages(span, 15)[0] ?? new Map(), 2) }
  })))
}
function decodeMetrics(bytes) {
  return messages(fields(bytes), 1).flatMap(resource => messages(resource, 2).flatMap(scope => messages(scope, 2).map(metric => ({
    name: text(metric, 1), unit: text(metric, 3),
    points: [...messages(metric, 7).flatMap(data => messages(data, 1).map(point => ({ attributes: attributes(point, 7),
      value: point.has(6) ? String(uint64(point, 6)) : point.has(4) ? list(point, 4)[0].readDoubleLE() : null }))),
    ...messages(metric, 9).flatMap(data => messages(data, 1).map(point => ({ attributes: attributes(point, 9),
      count: String(uint64(point, 4)), sum: point.has(5) ? list(point, 5)[0].readDoubleLE() : null })))],
  }))))
}
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ loopback: true, requests: sequence })); return
  }
  if (request.method !== 'POST' || !['/v1/traces', '/v1/metrics'].includes(request.url)) { response.writeHead(404).end(); return }
  const chunks = []; let size = 0
  request.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) request.destroy(); else chunks.push(chunk) })
  request.on('end', async () => {
    try {
      const bytes = Buffer.concat(chunks)
      const decoded = request.url === '/v1/traces' ? decodeTraces(bytes) : decodeMetrics(bytes)
      const id = ++sequence, kind = request.url.slice(4)
      const record = { receivedAt: new Date().toISOString(), kind, bytes: bytes.length, decoded }
      await writeFile(resolve(output, `${String(id).padStart(4, '0')}-${kind}.pb`), bytes, { mode: 0o600 })
      await writeFile(resolve(output, `${String(id).padStart(4, '0')}-${kind}.json`), JSON.stringify(record, null, 2), { mode: 0o600 })
      await appendFile(resolve(output, 'capture.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
      console.log(JSON.stringify({ request: id, kind, bytes: bytes.length, records: decoded.length }))
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end()
    } catch { response.writeHead(400).end(); console.error('OTLP decode/storage failed') }
  })
})
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, endpoint: `http://127.0.0.1:${port}`, output })))
server.on('error', error => { console.error(error.code ?? 'Collector failure'); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
