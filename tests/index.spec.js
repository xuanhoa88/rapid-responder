const { Readable } = require('stream');
const { ReadStream } = require('fs');
const Zlib = require('zlib');
const {
  ResponseBuilder,
  ResponseHelper,
  PROTOCOLS,
  httpResponder,
  ipcResponder,
  socketResponder,
} = require('../src');

describe('ResponseHelper', () => {
  describe('getStreamType', () => {
    it('detects gzip stream', () => {
      const gzip = Zlib.createGzip();
      expect(ResponseHelper.getStreamType(gzip)).toBe('application/gzip');
      gzip.destroy();
    });
    it('detects deflate stream', () => {
      const deflate = Zlib.createDeflate();
      expect(ResponseHelper.getStreamType(deflate)).toBe('application/deflate');
      deflate.destroy();
    });
    it('detects ReadStream', () => {
      const fakeReadStream = Object.create(ReadStream.prototype);
      expect(ResponseHelper.getStreamType(fakeReadStream)).toBe('application/octet-stream');
    });
    it('detects EventEmitter', () => {
      const { EventEmitter } = require('events');
      const emitter = new EventEmitter();
      expect(ResponseHelper.getStreamType(emitter)).toBe('application/stream');
    });
    it('returns octet-stream for unknown', () => {
      expect(ResponseHelper.getStreamType({})).toBe('application/octet-stream');
    });
  });

  describe('destroyStream', () => {
    it('destroys a ReadStream', () => {
      const fake = Object.create(ReadStream.prototype);
      fake.destroy = jest.fn();
      fake.close = jest.fn();
      fake.on = jest.fn((event, cb) => cb && cb());
      ResponseHelper.destroyStream(fake);
      expect(fake.destroy).toHaveBeenCalled();
      expect(fake.close).toHaveBeenCalled();
    });
    it('destroys a zlib stream', () => {
      const gzip = Zlib.createGzip();
      const spy = jest.spyOn(gzip, 'destroy');
      ResponseHelper.destroyStream(gzip);
      expect(spy).toHaveBeenCalled();
      gzip.destroy();
    });
    it('destroys a generic stream', () => {
      const stream = new Readable();
      const spy = jest.spyOn(stream, 'destroy');
      ResponseHelper.destroyStream(stream);
      expect(spy).toHaveBeenCalled();
    });
    it('suppresses errors if requested', () => {
      const { EventEmitter } = require('events');
      const emitter = new EventEmitter();
      emitter.destroy = jest.fn();
      emitter.removeAllListeners = jest.fn();
      emitter.on = jest.fn();
      ResponseHelper.destroyStream(emitter, true);
      expect(emitter.removeAllListeners).toHaveBeenCalledWith('error');
      expect(emitter.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
    it('handles already destroyed stream', () => {
      const stream = new Readable();
      stream.destroyed = true;
      stream.destroy = jest.fn();
      ResponseHelper.destroyStream(stream);
      expect(stream.destroy).toHaveBeenCalled();
    });
    it('handles destroy throwing error', () => {
      const stream = new Readable();
      stream.destroy = jest.fn(() => {
        throw new Error('fail');
      });
      expect(() => ResponseHelper.destroyStream(stream)).not.toThrow();
    });
  });

  describe('prepareBodyMetadata', () => {
    it('handles null/undefined', () => {
      expect(ResponseHelper.prepareBodyMetadata(null)).toEqual({ body: '', type: 'text/plain' });
      expect(ResponseHelper.prepareBodyMetadata(undefined)).toEqual({
        body: '',
        type: 'text/plain',
      });
    });
    it('detects JSON string', () => {
      expect(ResponseHelper.prepareBodyMetadata('{"a":1}')).toEqual({
        body: { a: 1 },
        type: 'application/json',
      });
    });
    it('detects HTML string', () => {
      expect(ResponseHelper.prepareBodyMetadata('<div>hi</div>')).toEqual({
        body: '<div>hi</div>',
        type: 'text/html',
      });
    });
    it('detects XML string', () => {
      expect(ResponseHelper.prepareBodyMetadata('<?xml version="1.0"?>')).toEqual({
        body: '<?xml version="1.0"?>',
        type: 'application/xml',
      });
    });
    it('detects base64 string', () => {
      expect(ResponseHelper.prepareBodyMetadata('dGVzdA==')).toEqual({
        body: 'dGVzdA==',
        type: 'application/base64',
      });
    });
    it('handles plain string', () => {
      expect(ResponseHelper.prepareBodyMetadata('hello')).toEqual({
        body: 'hello',
        type: 'text/plain',
      });
    });
    it('handles number, boolean, symbol, function', () => {
      expect(ResponseHelper.prepareBodyMetadata(42)).toEqual({ body: '42', type: 'text/plain' });
      expect(ResponseHelper.prepareBodyMetadata(true)).toEqual({
        body: 'true',
        type: 'text/plain',
      });
      expect(ResponseHelper.prepareBodyMetadata(Symbol('x'))).toEqual({
        body: 'Symbol(x)',
        type: 'text/plain',
      });
      expect(ResponseHelper.prepareBodyMetadata(() => 1)).toEqual({
        body: '() => 1',
        type: 'text/plain',
      });
    });
    it('handles Error', () => {
      const err = new Error('fail');
      const result = ResponseHelper.prepareBodyMetadata(err);
      expect(result.type).toBe('application/json');
      expect(result.body).toMatchObject({
        name: 'Error',
        message: 'fail',
      });
      expect(result.body.stack).toBeDefined();
    });
    it('handles Date', () => {
      const date = new Date();
      expect(ResponseHelper.prepareBodyMetadata(date)).toEqual({
        body: date.toISOString(),
        type: 'application/json',
      });
    });
    it('handles Buffer', () => {
      const buf = Buffer.from('abc');
      expect(ResponseHelper.prepareBodyMetadata(buf)).toEqual({
        body: buf,
        type: 'application/octet-stream',
      });
    });
    it('handles Array', () => {
      expect(ResponseHelper.prepareBodyMetadata([1, 2])).toEqual({
        body: [1, 2],
        type: 'application/json',
      });
    });
    it('handles Map/Set', () => {
      expect(ResponseHelper.prepareBodyMetadata(new Map([[1, 2]]))).toEqual({
        body: [[1, 2]],
        type: 'application/json',
      });
      expect(ResponseHelper.prepareBodyMetadata(new Set([1, 2]))).toEqual({
        body: [1, 2],
        type: 'application/json',
      });
    });
    it('handles object', () => {
      expect(ResponseHelper.prepareBodyMetadata({ a: 1 })).toEqual({
        body: { a: 1 },
        type: 'application/json',
      });
    });
    it('handles circular object fallback', () => {
      const obj = {};
      obj.self = obj;
      const result = ResponseHelper.prepareBodyMetadata(obj);
      expect(result.type).toBe('text/plain');
      expect(typeof result.body).toBe('string');
    });
  });
});

describe('ResponseBuilder', () => {
  it('sets status code', () => {
    const handler = new ResponseBuilder();
    handler.status(404);
    expect(handler.statusCode).toBe(404);
  });

  it('handles non-stream response', async () => {
    const handler = new ResponseBuilder();
    const result = await handler.send({ a: 1 });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ a: 1 });
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  it('handles error in non-stream', async () => {
    const handler = new ResponseBuilder();
    const err = new Error('fail');
    const result = await handler.send(err);
    expect(result.statusCode).toBe(500);
    expect(result.body).toMatchObject({ name: 'Error', message: 'fail' });
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  it('handles protocol switching', async () => {
    const handler = new ResponseBuilder({ protocol: PROTOCOLS.IPC });
    const result = await handler.send('hi');
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('hi');
    expect(result.type).toBe('text/plain');
  });

  it('throws on unknown protocol', () => {
    expect(() => new ResponseBuilder({ protocol: 'unknown' })).toThrow('Invalid protocol: unknown');
  });

  it('handles stream response (success)', async () => {
    const handler = new ResponseBuilder();
    const stream = new Readable();
    stream._read = () => {};
    stream.push('abc');
    stream.push(null);
    const result = await handler.send(stream);
    expect(result.body.equals(Buffer.from('abc'))).toBe(true);
    expect(result.type).toBe('application/octet-stream');
    expect(result.size).toBe(3);
  });

  it('handles stream timeout', async () => {
    const handler = new ResponseBuilder({ streamTimeout: 10 });
    const stream = new Readable({ read() {} });
    await expect(handler.send(stream)).rejects.toThrow('Stream processing timed out');
    stream.destroy();
  });

  it('handles stream size limit', async () => {
    const handler = new ResponseBuilder({ maxStreamSize: 2 });
    const stream = new Readable();
    stream.push('abc'); // push synchronously
    stream.push(null);
    await expect(handler.send(stream)).rejects.toThrow('Stream size 3 exceeded maximum limit 2');
    stream.destroy();
  });

  it('handles stream error', async () => {
    const handler = new ResponseBuilder();
    const stream = new Readable();
    stream._read = () => {};
    const promise = handler.send(stream);
    stream.emit('error', new Error('fail'));
    await expect(promise).rejects.toThrow('fail');
    stream.destroy();
  });

  it('uses custom error handler for stream', async () => {
    const handler = new ResponseBuilder({
      errorHandler: err => {
        if (err.message === 'fail') return new Error('custom');
      },
    });
    const stream = new Readable();
    stream._read = () => {};
    const promise = handler.send(stream);
    stream.emit('error', new Error('fail'));
    await expect(promise).rejects.toThrow('custom');
    stream.destroy();
  });
});

describe('protocol responders', () => {
  it('httpResponder.ok returns HTTP response', async () => {
    const res = await httpResponder.ok('hi');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hi');
    expect(res.headers['Content-Type']).toBe('text/plain');
  });
  it('httpResponder.ok handles object body', async () => {
    const res = await httpResponder.ok({ foo: 'bar' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ foo: 'bar' });
    expect(res.headers['Content-Type']).toBe('application/json');
  });
  it('ipcResponder.notFound returns IPC response', async () => {
    const res = await ipcResponder.notFound('no');
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('no');
    expect(res.type).toBe('text/plain');
  });
  it('ipcResponder.notFound handles stream body', async () => {
    const stream = new Readable();
    stream._read = () => {};
    stream.push('abc');
    stream.push(null);
    const res = await ipcResponder.notFound(stream);
    expect(res.body.equals(Buffer.from('abc'))).toBe(true);
    expect(res.type).toBe('application/octet-stream');
    expect(res.size).toBe(3);
    stream.destroy();
  });
  it('socketResponder.internalServerError returns Socket response', async () => {
    const res = await socketResponder.internalServerError('fail');
    expect(res.statusCode).toBe(500);
    expect(res.message).toBe('fail');
    expect(res.type).toBe('text/plain');
  });
  it('socketResponder.internalServerError handles object body', async () => {
    const res = await socketResponder.internalServerError({ err: true });
    expect(res.statusCode).toBe(500);
    expect(res.message).toEqual({ err: true });
    expect(res.type).toBe('application/json');
  });
  it('httpResponder.ok with stream body throws on stream error', async () => {
    const stream = new Readable();
    stream._read = () => {};
    const promise = httpResponder.ok(stream);
    stream.emit('error', new Error('fail'));
    await expect(promise).rejects.toThrow('fail');
    stream.destroy();
  });
});
