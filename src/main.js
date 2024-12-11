const { EventEmitter } = require('events');
const { ReadStream } = require('fs');
const Zlib = require('zlib');

/**
 * Enum for supported communication protocols
 * @enum {string}
 */
const PROTOCOLS = Object.freeze({
  HTTP: 'http',
  IPC: 'ipc',
  SOCKET: 'socket',
});

/**
 * Enum for standard status codes
 * @enum {number}
 */
const STATUS_CODES = Object.freeze({
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  internalServerError: 500,
  notImplemented: 501,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
});

/**
 * Utility class for stream and response handling
 */
class ResponseUtils {
  /**
   * Detect MIME type of a stream
   * @param {Stream} stream - Input stream
   * @returns {string} Detected MIME type
   */
  static detectStreamType(stream) {
    const streamTypeMap = {
      'application/gzip': ['Gzip', 'Deflate', 'Gunzip', 'Inflate'],
      'application/octet-stream': ['ReadStream'],
      'application/stream': ['EventEmitter'],
    };

    for (const [type, classes] of Object.entries(streamTypeMap)) {
      if (
        classes.some(
          className => stream instanceof Zlib[className] || stream.constructor.name === className
        )
      ) {
        return type;
      }
    }

    return 'application/octet-stream';
  }

  /**
   * Safely destroy different types of streams
   * @param {Stream} stream - Stream to destroy
   * @param {boolean} [suppressErrors=false] - Suppress error events
   * @returns {Stream} Destroyed stream
   */
  static destroyStream(stream, suppressErrors = false) {
    try {
      // Comprehensive stream destruction logic
      const streamDestructionMethods = [
        {
          condition: stream instanceof ReadStream,
          destroy: () => {
            stream.destroy();
            if (typeof stream.close === 'function') {
              stream.on('open', () => stream.close());
            }
          },
        },
        {
          condition:
            stream instanceof Zlib.Gzip ||
            stream instanceof Zlib.Gunzip ||
            stream instanceof Zlib.Deflate ||
            stream instanceof Zlib.DeflateRaw ||
            stream instanceof Zlib.Inflate ||
            stream instanceof Zlib.InflateRaw ||
            stream instanceof Zlib.Unzip,
          destroy: () => {
            if (typeof stream.destroy === 'function') stream.destroy();
            if (typeof stream.close === 'function') stream.close();
          },
        },
        {
          condition: stream && typeof stream.destroy === 'function',
          destroy: () => stream.destroy(),
        },
      ];

      // Find and execute the first matching destruction method
      const destructionMethod = streamDestructionMethods.find(method => method.condition);
      if (destructionMethod) destructionMethod.destroy();

      // Optionally suppress error events
      if (suppressErrors && stream instanceof EventEmitter) {
        stream.removeAllListeners('error');
        stream.on('error', () => {});
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Stream destruction encountered an issue:', err);
    }

    return stream;
  }

  /**
   * Determine content type and transform body
   * @param {*} body - Response body to process
   * @returns {object} Processed body with type
   */
  static determineContentType(body) {
    // Handle null or undefined
    if (body === null || body === undefined) {
      return { body: '', type: 'text/plain' };
    }

    const type = typeof body;

    // Specialized type handlers
    const typeHandlers = [
      {
        test: () => type === 'string',
        handle: () => {
          const trimmed = body.trim();
          try {
            // JSON parsing
            return JSON.parse(trimmed)
              ? { body: JSON.parse(trimmed), type: 'application/json' }
              : null;
          } catch {
            // Content type detection
            if (/^\s*<[\s\S]*>/.test(trimmed)) return { body: trimmed, type: 'text/html' };
            if (/^\s*<\?xml/.test(trimmed)) return { body: trimmed, type: 'application/xml' };
            if (
              /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/.test(
                trimmed
              )
            )
              return { body: trimmed, type: 'application/base64' };
            return { body: trimmed, type: 'text/plain' };
          }
        },
      },
      {
        test: () => ['number', 'boolean', 'symbol', 'function'].includes(type),
        handle: () => ({ body: String(body), type: 'text/plain' }),
      },
      {
        test: () => type === 'object',
        handle: () => {
          if (body instanceof Error) return { body, type: 'application/json' };
          if (body instanceof Date) return { body: body.toISOString(), type: 'text/plain' };
          if (Buffer.isBuffer(body)) return { body, type: 'application/octet-stream' };
          if (Array.isArray(body)) return { body, type: 'application/json' };
          if (body instanceof Map || body instanceof Set)
            return { body: Array.from(body), type: 'application/json' };

          try {
            return { body, type: 'application/json' };
          } catch {
            return { body: String(body), type: 'text/plain' };
          }
        },
      },
    ];

    // Find and execute the first matching type handler
    const handler = typeHandlers.find(h => h.test());
    return handler ? handler.handle() : { body: String(body), type: 'text/plain' };
  }
}

/**
 * Adaptive Response Handler for multiple communication protocols
 */
class ResponseHandler {
  /**
   * Constructor with configurable options
   * @param {Object} [options={}] - Configuration options
   */
  constructor(options = {}) {
    this.protocol = options.protocol || PROTOCOLS.HTTP;
    this.statusCode = STATUS_CODES.ok;
    this.headers = options.headers || {};
    this.streamTimeout = options.streamTimeout || 30000;
    this.maxStreamSize = options.maxStreamSize || 50 * 1024 * 1024;
    this.customErrorHandler = options.errorHandler;
  }

  /**
   * Set response status code
   * @param {number} code - Status code
   * @returns {ResponseHandler} Current instance
   */
  status(code) {
    this.statusCode = code;
    return this;
  }

  /**
   * Processes the response body.
   * Determines whether the body is a stream or a non-stream response,
   * handles it accordingly, and checks for errors in the response payload.
   *
   * @param {*} body - The response body to process. Can be a stream or an object.
   * @returns {Object|Promise} The processed response or a promise if the body is a stream.
   */
  _processBody(body) {
    // Check if the body is a stream (has a `pipe` function)
    if (body && typeof body.pipe === 'function') {
      return this._handleStreamResponse(body);
    }

    // Process the body as a non-stream response
    return this._handleNonStreamResponse(body);
  }

  /**
   * Handle stream-based responses
   * @param {Stream} stream - Input stream
   * @returns {Promise} Processed stream response
   */
  _handleStreamResponse(stream) {
    return new Promise((resolve, reject) => {
      const payload = { chunks: [], totalBytes: 0 };
      const timeoutHandler = setTimeout(() => {
        ResponseUtils.destroyStream(stream);
        const timeoutError = new Error('Stream processing timed out');
        timeoutError.code = 'STREAM_TIMEOUT';
        reject(timeoutError);
      }, this.streamTimeout);

      const errorHandler = error => {
        clearTimeout(timeoutHandler);
        const type = ResponseUtils.detectStreamType(stream);
        ResponseUtils.destroyStream(stream);

        if (typeof this.customErrorHandler === 'function') {
          const customError = this.customErrorHandler(error);
          if (customError) {
            reject(customError);
            return;
          }
        }

        this.status(
          `${error.code}`.toUpperCase() === 'ENOENT'
            ? STATUS_CODES.notFound
            : STATUS_CODES.internalServerError
        );

        reject({ type, body: error });
      };

      const dataHandler = chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        payload.totalBytes += buffer.length;

        if (payload.totalBytes > this.maxStreamSize) {
          ResponseUtils.destroyStream(stream);
          const sizeError = new Error('Stream size exceeded maximum limit');
          sizeError.code = 'STREAM_SIZE_LIMIT';
          reject(sizeError);
          return;
        }

        payload.chunks.push(buffer);
      };

      const endHandler = () => {
        clearTimeout(timeoutHandler);

        try {
          // Ensure stream is destroyed properly when the stream ends
          ResponseUtils.destroyStream(stream, true); // Optional: suppress errors
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('Error during stream destruction:', err);
        }

        stream.removeListener('error', errorHandler);
        stream.removeListener('data', dataHandler);

        resolve({
          body: Buffer.concat(payload.chunks),
          type: ResponseUtils.detectStreamType(stream),
          size: payload.totalBytes,
        });
      };

      stream.on('error', errorHandler);
      stream.on('data', dataHandler);
      stream.on('end', endHandler);
    });
  }

  /**
   * Handle non-stream responses
   * @param {*} body - Response body
   * @returns {Object} Processed response
   */
  _handleNonStreamResponse(body) {
    const payload = ResponseUtils.determineContentType(body);
    // Check if the response payload contains an error
    if (payload && payload.body instanceof Error) {
      this.status(STATUS_CODES.internalServerError);
    }
    return payload;
  }

  /**
   * Send response based on protocol
   * @param {*} [body=null] - Response body
   * @returns {Promise|Object} Response
   */
  send(body = null) {
    const processedBody = this._processBody(body);

    const protocolHandlers = {
      [PROTOCOLS.HTTP]: this._httpResponse.bind(this),
      [PROTOCOLS.IPC]: this._ipcResponse.bind(this),
      [PROTOCOLS.SOCKET]: this._socketResponse.bind(this),
    };

    const handler = protocolHandlers[this.protocol];
    if (!handler) throw new Error(`Unsupported protocol: ${this.protocol}`);

    return handler(processedBody);
  }

  /**
   * HTTP response formatting
   * @param {Object} processedBody - Processed response body
   * @returns {Object} HTTP response
   */
  _httpResponse(processedBody) {
    return {
      statusCode: this.statusCode,
      headers: {
        'Content-Type': processedBody.type,
        ...this.headers,
      },
      body: JSON.stringify(processedBody.body),
    };
  }

  /**
   * IPC response formatting
   * @param {Object} processedBody - Processed response body
   * @returns {Object} IPC response
   */
  _ipcResponse(processedBody) {
    return {
      statusCode: this.statusCode,
      body: processedBody.body,
      type: processedBody.type,
    };
  }

  /**
   * Socket response formatting
   * @param {Object} processedBody - Processed response body
   * @returns {Object} Socket response
   */
  _socketResponse(processedBody) {
    return {
      statusCode: this.statusCode,
      message: processedBody.body,
      type: processedBody.type,
    };
  }
}

// Create an object called protocolExports by reducing over the entries of the PROTOCOLS object.
const protocolExports = Object.entries(PROTOCOLS).reduce(
  (initialValue, [_, protocolValue]) => {
    // For each protocol (e.g., http, ftp), create a property with the name 'protocolKeyResponder'.
    initialValue[`${protocolValue}Responder`] = {
      // Create an object for the responder using Object.fromEntries to convert the array of method-status pairs into an object.
      ...Object.fromEntries(
        // Map over the entries of STATUS_CODES to generate methods for each status code.
        Object.entries(STATUS_CODES).map(([methodName, statusCode]) => [
          // For each status code, map the method name (e.g., 'ok', 'notFound') to a function.
          methodName,
          // Use ResponseHandler to create a handler for each status code tied to the current protocol value.
          function (body, options = {}) {
            const handler = new ResponseHandler({ ...options, protocol: protocolValue });
            handler.status(statusCode);
            return handler.send(body);
          },
        ])
      ),
    };
    // Return the updated accumulator object (initialValue).
    return initialValue;
  },
  // Start with an empty object to accumulate the protocol responders.
  {}
);

module.exports = { ResponseHandler, PROTOCOLS, ...protocolExports };
