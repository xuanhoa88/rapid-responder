const { EventEmitter } = require('events');
const { ReadStream } = require('fs');
const Zlib = require('zlib');

// Constants for configuration
const DEFAULT_STREAM_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_STREAM_SIZE = 50 * 1024 * 1024; // 50MB
const MIN_BASE64_LENGTH = 4;
const BASE64_CHUNK_SIZE = 4;

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
  accepted: 202,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  unprocessableEntity: 422,
  tooManyRequests: 429,
  internalServerError: 500,
  notImplemented: 501,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
});

/**
 * Custom error classes for better error handling
 */
class StreamTimeoutError extends Error {
  constructor(timeout) {
    super(`Stream processing timed out after ${timeout}ms`);
    this.name = 'StreamTimeoutError';
    this.code = 'STREAM_TIMEOUT';
    this.timeout = timeout;
  }
}

class StreamSizeLimitError extends Error {
  constructor(limit, actual) {
    super(`Stream size ${actual} exceeded maximum limit ${limit}`);
    this.name = 'StreamSizeLimitError';
    this.code = 'STREAM_SIZE_LIMIT';
    this.limit = limit;
    this.actual = actual;
  }
}

class InvalidStatusCodeError extends Error {
  constructor(code) {
    super(`Invalid status code: ${code}. Must be a number between 100 and 599`);
    this.name = 'InvalidStatusCodeError';
    this.code = 'INVALID_STATUS_CODE';
    this.statusCode = code;
  }
}

/**
 * Utility class for stream and response handling
 * @exports ResponseHelper
 */
class ResponseHelper {
  /**
   * Detect MIME type of a stream with improved reliability
   * @param {Stream} stream - Input stream
   * @returns {string} Detected MIME type
   */
  static getStreamType(stream) {
    if (!stream) return 'application/octet-stream';

    // Enhanced stream type mapping with more specific detection
    const streamTypeMap = {
      'application/gzip': ['Gzip', 'Gunzip'],
      'application/deflate': ['Deflate', 'DeflateRaw', 'Inflate', 'InflateRaw'],
      'application/zip': ['Unzip'],
      'application/octet-stream': ['ReadStream', 'FileReadStream'],
      'application/stream': ['EventEmitter', 'Readable', 'Transform', 'PassThrough'],
    };

    // Try Symbol.toStringTag first (most reliable)
    const tag = stream[Symbol.toStringTag];
    if (tag) {
      for (const [mimeType, tags] of Object.entries(streamTypeMap)) {
        if (tags.includes(tag)) return mimeType;
      }
    }

    // Fallback to instanceof checks and constructor name
    for (const [mimeType, classNames] of Object.entries(streamTypeMap)) {
      if (
        classNames.some(className => {
          // Check Zlib instances
          if (Zlib[className] && typeof Zlib[className] === 'function' && stream instanceof Zlib[className]) return true;
          // Check constructor name
          if (stream.constructor?.name === className) return true;
          // Check if stream has specific methods (duck typing)
          if (className === 'Readable' && typeof stream.read === 'function') return true;
          return false;
        })
      ) {
        return mimeType;
      }
    }

    return 'application/octet-stream';
  }

  /**
   * Safely destroy different types of streams with improved error handling
   * @param {Stream} stream - Stream to destroy
   * @param {boolean} [suppressErrors=false] - Suppress error events
   * @param {function} [onError] - Optional error handler callback
   * @returns {Stream} Destroyed stream
   */
  static destroyStream(stream, suppressErrors = false, onError) {
    if (!stream) return stream;

    try {
      // Enhanced stream destruction with proper cleanup order
      const streamDestructionMethods = [
        {
          condition: stream && typeof ReadStream === 'function' && stream instanceof ReadStream,
          destroy: () => {
            // Remove listeners before destroying
            if (suppressErrors && typeof stream.removeAllListeners === 'function') {
              stream.removeAllListeners('error');
            }

            // Always call destroy for test expectations
            if (typeof stream.destroy === 'function') {
              stream.destroy();
            }

            // Handle file streams properly
            if (typeof stream.close === 'function') {
              if (stream.fd !== null && !stream.closed) {
                stream.on('open', () => {
                  if (!stream.destroyed) stream.close();
                });
              }
            }
          },
        },
        {
          condition: stream && Object.values(Zlib).some(ZlibClass => typeof ZlibClass === 'function' && stream instanceof ZlibClass),
          destroy: () => {
            if (suppressErrors && typeof stream.removeAllListeners === 'function') {
              stream.removeAllListeners('error');
            }

            if (typeof stream.destroy === 'function') {
              stream.destroy();
            }

            if (typeof stream.close === 'function') {
              stream.close();
            }
          },
        },
        {
          condition: stream && typeof stream.destroy === 'function',
          destroy: () => {
            if (suppressErrors && typeof stream.removeAllListeners === 'function') {
              stream.removeAllListeners('error');
            }

            // Always call destroy for test expectations
            stream.destroy();
          },
        },
      ];

      // Execute the first matching destruction method
      const destructionMethod = streamDestructionMethods.find(method => method.condition);
      if (destructionMethod) {
        destructionMethod.destroy();
      }

      // Add error suppression after destruction
      if (suppressErrors && stream instanceof EventEmitter && typeof stream.on === 'function') {
        stream.on('error', () => {}); // Prevent unhandled errors
      }
    } catch (err) {
      if (typeof onError === 'function') {
        onError(err);
      } else if (!suppressErrors) {
        // eslint-disable-next-line no-console
        console.warn('Stream destruction encountered an issue:', err.message);
      }
    }

    return stream;
  }

  /**
   * Enhanced Base64 validation
   * @param {string} str - String to validate
   * @returns {boolean} Whether the string is valid Base64
   */
  static isValidBase64(str) {
    if (typeof str !== 'string' || str.length < MIN_BASE64_LENGTH) {
      return false;
    }

    if (str.length % BASE64_CHUNK_SIZE !== 0) {
      return false;
    }

    // Only consider as base64 if it decodes to something non-empty and is not plain text
    try {
      const decoded = Buffer.from(str, 'base64');
      if (!decoded.length) return false;
      // If the decoded buffer re-encodes to the same string, and the string is not a common word
      return decoded.toString('base64') === str && !/^[a-zA-Z0-9]+$/.test(str);
    } catch {
      return false;
    }
  }

  /**
   * Enhanced content type detection with better parsing logic
   * @param {string} content - Content to analyze
   * @returns {string|null} Detected content type or null
   */
  static getContentType(content) {
    const trimmed = content.trim();

    if (!trimmed) return 'text/plain';

    // JSON detection - try parsing first
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        JSON.parse(trimmed);
        return 'application/json';
      } catch {
        // Continue to other checks
      }
    }

    // XML detection
    if (/^<\?xml\s/i.test(trimmed)) {
      return 'application/xml';
    }

    // HTML detection - match any string starting with < and ending with >
    if (/^<.+>$/s.test(trimmed)) {
      return 'text/html';
    }

    // SVG detection
    if (/^\s*<svg[\s>]/i.test(trimmed)) {
      return 'image/svg+xml';
    }

    // CSS detection
    if (/^\s*(@import|@charset|\/\*|\w+\s*\{)/i.test(trimmed)) {
      return 'text/css';
    }

    // Base64 detection - use improved validation
    if (this.isValidBase64(trimmed)) {
      return 'application/base64';
    }

    return 'text/plain';
  }

  /**
   * Enhanced content type determination with better error handling
   * @param {*} body - Response body to process
   * @param {string} [forceType] - Optional override for content type
   * @returns {object} Processed body with type
   */
  static prepareBodyMetadata(body, forceType) {
    if (forceType) return { body, type: forceType };

    // Handle null or undefined
    if (body == null) {
      return { body: '', type: 'text/plain' };
    }

    const type = typeof body;

    // Enhanced type handlers with better logic
    const typeHandlers = [
      {
        test: () => type === 'string',
        handle: () => {
          const detectedType = this.getContentType(body);

          // For JSON, parse and return the parsed object
          if (detectedType === 'application/json') {
            try {
              const parsed = JSON.parse(body.trim());
              return { body: parsed, type: 'application/json' };
            } catch (err) {
              // If parsing fails, treat as plain text
              return { body: body.trim(), type: 'text/plain' };
            }
          }

          return { body: body, type: detectedType };
        },
      },
      {
        test: () => ['number', 'boolean', 'symbol'].includes(type),
        handle: () => ({ body: String(body), type: 'text/plain' }),
      },
      {
        test: () => type === 'function',
        handle: () => ({ body: body.toString(), type: 'text/plain' }),
      },
      {
        test: () => type === 'bigint',
        handle: () => ({ body: body.toString(), type: 'text/plain' }),
      },
      {
        test: () => type === 'object',
        handle: () => {
          // Handle Error objects specially
          if (body instanceof Error) {
            const errorObj = {
              name: body.name,
              message: body.message,
              stack: body.stack,
              ...Object.getOwnPropertyNames(body).reduce((acc, key) => {
                if (!['name', 'message', 'stack'].includes(key)) {
                  acc[key] = body[key];
                }
                return acc;
              }, {}),
            };
            return { body: errorObj, type: 'application/json' };
          }

          if (body instanceof Date) {
            return { body: body.toISOString(), type: 'application/json' };
          }

          if (Buffer.isBuffer(body)) {
            return { body, type: 'application/octet-stream' };
          }

          if (Array.isArray(body)) {
            return { body, type: 'application/json' };
          }

          if (body instanceof Map) {
            return { body: Array.from(body.entries()), type: 'application/json' };
          }

          if (body instanceof Set) {
            return { body: Array.from(body), type: 'application/json' };
          }

          if (body instanceof RegExp) {
            return { body: body.toString(), type: 'text/plain' };
          }

          // Handle circular references and serialization errors
          try {
            // Test if object can be serialized
            JSON.stringify(body);
            return { body, type: 'application/json' };
          } catch (err) {
            // If serialization fails, convert to string representation
            return { body: String(body), type: 'text/plain' };
          }
        },
      },
    ];

    // Find and execute the first matching type handler
    const handler = typeHandlers.find(h => h.test());
    return handler ? handler.handle() : { body: String(body), type: 'text/plain' };
  }

  /**
   * Validate status code
   * @param {number} code - Status code to validate
   * @returns {boolean} Whether the status code is valid
   */
  static isValidStatusCode(code) {
    return typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599;
  }
}

/**
 * Enhanced Adaptive Response Handler for multiple communication protocols
 */
class ResponseBuilder {
  /**
   * Constructor with enhanced validation and configuration
   * @param {Object} [options={}] - Configuration options
   * @param {string} [options.protocol] - Communication protocol
   * @param {Object} [options.headers] - Default headers
   * @param {number} [options.streamTimeout] - Stream processing timeout
   * @param {number} [options.maxStreamSize] - Maximum stream size
   * @param {function} [options.errorHandler] - Custom error handler
   * @param {string} [options.contentType] - Content type override
   */
  constructor(options = {}) {
    // Validate protocol
    if (options.protocol && !Object.values(PROTOCOLS).includes(options.protocol)) {
      throw new Error(
        `Invalid protocol: ${options.protocol}. Must be one of: ${Object.values(PROTOCOLS).join(', ')}`
      );
    }

    this.protocol = options.protocol || PROTOCOLS.HTTP;
    this.statusCode = STATUS_CODES.ok;
    this.headers = { ...options.headers } || {};
    this.streamTimeout = options.streamTimeout || DEFAULT_STREAM_TIMEOUT;
    this.maxStreamSize = options.maxStreamSize || DEFAULT_MAX_STREAM_SIZE;
    this.customErrorHandler = options.errorHandler;
    this.contentTypeOverride = options.contentType;

    // Validate configuration
    if (this.streamTimeout <= 0) {
      throw new Error('Stream timeout must be a positive number');
    }
    if (this.maxStreamSize <= 0) {
      throw new Error('Max stream size must be a positive number');
    }
  }

  /**
   * Set response status code with validation
   * @param {number} code - Status code
   * @returns {ResponseBuilder} Current instance
   * @throws {InvalidStatusCodeError} When status code is invalid
   */
  status(code) {
    if (!ResponseHelper.isValidStatusCode(code)) {
      throw new InvalidStatusCodeError(code);
    }
    this.statusCode = code;
    return this;
  }

  /**
   * Set response headers
   * @param {Object} headers - Headers to set
   * @returns {ResponseBuilder} Current instance
   */
  headers(headers) {
    if (headers && typeof headers === 'object') {
      this.headers = { ...this.headers, ...headers };
    }
    return this;
  }

  /**
   * Set individual header
   * @param {string} name - Header name
   * @param {string} value - Header value
   * @returns {ResponseBuilder} Current instance
   */
  header(name, value) {
    if (typeof name === 'string' && value !== undefined) {
      this.headers[name] = String(value);
    }
    return this;
  }

  /**
   * Enhanced body processing with consistent return types
   * @param {*} body - The response body to process
   * @returns {Promise<Object>} Always returns a promise for consistency
   */
  async #processBody(body) {
    // Check if the body is a stream
    if (body && typeof body.pipe === 'function') {
      return await this.#handleStreamResponse(body);
    }

    // Process non-stream responses
    return this.#handleNonStreamResponse(body);
  }

  /**
   * Enhanced stream handling with better error management and cleanup
   * @param {Stream} stream - Input stream
   * @returns {Promise<Object>} Processed stream response
   */
  #handleStreamResponse(stream) {
    return new Promise((resolve, reject) => {
      const payload = { chunks: [], totalBytes: 0 };
      let isSettled = false;

      // Enhanced timeout handling
      const timeoutHandler = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;

        this.#cleanupStreamListeners(stream, { errorHandler, dataHandler, endHandler });
        ResponseHelper.destroyStream(stream, true);
        reject(new StreamTimeoutError(this.streamTimeout));
      }, this.streamTimeout);

      const errorHandler = error => {
        if (isSettled) return;
        isSettled = true;

        clearTimeout(timeoutHandler);
        this.#cleanupStreamListeners(stream, { dataHandler, endHandler });
        ResponseHelper.destroyStream(stream, true);

        // Handle custom error processing
        if (typeof this.customErrorHandler === 'function') {
          try {
            const customError = this.customErrorHandler(error);
            if (customError) {
              reject(customError);
              return;
            }
          } catch (customHandlerError) {
            reject(customHandlerError);
            return;
          }
        }

        // Set appropriate status code based on error
        if (error.code === 'ENOENT') {
          this.status(STATUS_CODES.notFound);
        } else if (error.code === 'EACCES') {
          this.status(STATUS_CODES.forbidden);
        } else {
          this.status(STATUS_CODES.internalServerError);
        }

        // Always reject with proper Error instance
        const finalError = error instanceof Error ? error : new Error('Stream error');
        if (!(error instanceof Error)) {
          finalError.original = error;
        }
        reject(finalError);
      };

      const dataHandler = chunk => {
        if (isSettled) return;

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        payload.totalBytes += buffer.length;

        // Check size limit
        if (payload.totalBytes > this.maxStreamSize) {
          isSettled = true;
          clearTimeout(timeoutHandler);
          this.#cleanupStreamListeners(stream, { errorHandler, endHandler });
          ResponseHelper.destroyStream(stream, true);

          const sizeError = new StreamSizeLimitError(this.maxStreamSize, payload.totalBytes);
          setImmediate(() => reject(sizeError));
          return;
        }

        payload.chunks.push(buffer);
      };

      const endHandler = () => {
        if (isSettled) return;
        isSettled = true;

        clearTimeout(timeoutHandler);
        this.#cleanupStreamListeners(stream, { errorHandler, dataHandler });

        // Cleanup stream resources
        try {
          ResponseHelper.destroyStream(stream, true);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('Error during stream cleanup:', err.message);
        }

        resolve({
          body: Buffer.concat(payload.chunks),
          type: 'application/octet-stream',
          size: payload.totalBytes,
        });
      };

      // Attach event listeners
      stream.on('error', errorHandler);
      stream.on('data', dataHandler);
      stream.on('end', endHandler);
    });
  }

  /**
   * Clean up stream event listeners
   * @param {Stream} stream - Stream to clean up
   * @param {Object} handlers - Handler functions to remove
   */
  #cleanupStreamListeners(stream, handlers) {
    if (!stream || !handlers) return;

    Object.entries(handlers).forEach(([name, handler]) => {
      if (handler) {
        const eventName = name.replace('Handler', '');
        stream.removeListener(eventName, handler);
      }
    });
  }

  /**
   * Enhanced non-stream response handling
   * @param {*} body - Response body
   * @returns {Object} Processed response
   */
  #handleNonStreamResponse(body) {
    const payload = ResponseHelper.prepareBodyMetadata(body, this.contentTypeOverride);

    // Set error status for Error objects
    if (body instanceof Error) {
      this.status(STATUS_CODES.internalServerError);
    }

    return payload;
  }

  /**
   * Enhanced send method with consistent async behavior
   * @param {*} [body=null] - Response body
   * @returns {Promise<Object>} Response promise
   */
  async send(body = null) {
    try {
      const processedBody = await this.#processBody(body);

      const protocolHandlers = {
        [PROTOCOLS.HTTP]: this.#httpResponse.bind(this),
        [PROTOCOLS.IPC]: this.#ipcResponse.bind(this),
        [PROTOCOLS.SOCKET]: this.#socketResponse.bind(this),
      };

      const handler = protocolHandlers[this.protocol];
      if (!handler) {
        throw new Error(`Unsupported protocol: ${this.protocol}`);
      }

      // Always include type and size if present
      if (processedBody && (processedBody.type || processedBody.size)) {
        return { ...handler(processedBody), type: processedBody.type, size: processedBody.size };
      }

      return handler(processedBody);
    } catch (error) {
      // Enhance error with context
      if (
        error.name !== 'StreamTimeoutError' &&
        error.name !== 'StreamSizeLimitError' &&
        error.name !== 'InvalidStatusCodeError'
      ) {
        error.context = { protocol: this.protocol, statusCode: this.statusCode };
      }
      throw error;
    }
  }

  /**
   * Enhanced HTTP response formatting
   * @param {Object} processedBody - Processed response body
   * @returns {Object} HTTP response
   */
  #httpResponse(processedBody) {
    return {
      statusCode: this.statusCode,
      headers: {
        'Content-Type': processedBody.type,
        'X-Response-Time': new Date().toISOString(),
        ...this.headers,
      },
      body: processedBody.body,
      ...(processedBody.size && { size: processedBody.size }),
    };
  }

  /**
   * Enhanced IPC response formatting
   * @param {Object} processedBody - Processed response body
   * @returns {Object} IPC response
   */
  #ipcResponse(processedBody) {
    return {
      statusCode: this.statusCode,
      body: processedBody.body,
      type: processedBody.type,
      timestamp: Date.now(),
      ...(processedBody.size && { size: processedBody.size }),
    };
  }

  /**
   * Enhanced Socket response formatting
   * @param {Object} processedBody - Processed response body
   * @returns {Object} Socket response
   */
  #socketResponse(processedBody) {
    return {
      statusCode: this.statusCode,
      message: processedBody.body,
      type: processedBody.type,
      timestamp: Date.now(),
      ...(processedBody.size && { size: processedBody.size }),
    };
  }
}

/**
 * Enhanced protocol responders with improved error handling
 * @typedef {Object} ProtocolResponder
 * @property {function(*, Object=): Promise<Object>} ok - 200 OK
 * @property {function(*, Object=): Promise<Object>} created - 201 Created
 * @property {function(*, Object=): Promise<Object>} accepted - 202 Accepted
 * @property {function(*, Object=): Promise<Object>} noContent - 204 No Content
 * @property {function(*, Object=): Promise<Object>} badRequest - 400 Bad Request
 * @property {function(*, Object=): Promise<Object>} unauthorized - 401 Unauthorized
 * @property {function(*, Object=): Promise<Object>} forbidden - 403 Forbidden
 * @property {function(*, Object=): Promise<Object>} notFound - 404 Not Found
 * @property {function(*, Object=): Promise<Object>} methodNotAllowed - 405 Method Not Allowed
 * @property {function(*, Object=): Promise<Object>} conflict - 409 Conflict
 * @property {function(*, Object=): Promise<Object>} unprocessableEntity - 422 Unprocessable Entity
 * @property {function(*, Object=): Promise<Object>} tooManyRequests - 429 Too Many Requests
 * @property {function(*, Object=): Promise<Object>} internalServerError - 500 Internal Server Error
 * @property {function(*, Object=): Promise<Object>} notImplemented - 501 Not Implemented
 * @property {function(*, Object=): Promise<Object>} badGateway - 502 Bad Gateway
 * @property {function(*, Object=): Promise<Object>} serviceUnavailable - 503 Service Unavailable
 * @property {function(*, Object=): Promise<Object>} gatewayTimeout - 504 Gateway Timeout
 */
const protocolExports = Object.entries(PROTOCOLS).reduce((accumulator, [_, protocolValue]) => {
  /**
   * @type {ProtocolResponder}
   */
  accumulator[`${protocolValue}Responder`] = Object.fromEntries(
    Object.entries(STATUS_CODES).map(([methodName, statusCode]) => [
      methodName,
      /**
       * Enhanced responder function with consistent async behavior
       * @param {*} body - Response body
       * @param {Object} [options={}] - Handler options
       * @returns {Promise<Object>} Response promise
       */
      async function (body, options = {}) {
        try {
          const handler = new ResponseBuilder({
            ...options,
            protocol: protocolValue,
          });
          handler.status(statusCode);
          return await handler.send(body);
        } catch (error) {
          // Add method context to error
          error.method = methodName;
          error.protocol = protocolValue;
          throw error;
        }
      },
    ])
  );
  return accumulator;
}, {});

/**
 * Collection of usage examples for the ResponseBuilder module.
 *
 * @example <caption>1. Simple HTTP Response</caption>
 *
 * async function basicHttpExample() {
 *   const handler = new ResponseBuilder({ protocol: PROTOCOLS.HTTP });
 *
 *   // Simple success response
 *   const response = await handler.status(STATUS_CODES.ok).send({ message: 'Hello World' });
 *   console.log(response);
 *   // Output:
 *   // {
 *   //   statusCode: 200,
 *   //   headers: { 'Content-Type': 'application/json', 'X-Response-Time': '...' },
 *   //   body: { message: 'Hello World' }
 *   // }
 * }
 *
 * @example <caption>2. Protocol-Specific Responders</caption>
 *
 * async function protocolRespondersExample() {
 *   const httpOk = await httpResponder.ok({ data: 'success' });
 *   const httpError = await httpResponder.badRequest({ error: 'Invalid input' });
 *   const ipcResponse = await ipcResponder.created({ id: 123, name: 'New Item' });
 *   const socketResponse = await socketResponder.notFound({ error: 'Resource not found' });
 *
 *   console.log('HTTP OK:', httpOk);
 *   console.log('IPC Created:', ipcResponse);
 *   console.log('Socket Not Found:', socketResponse);
 * }
 *
 * @example <caption>3. Stream Handling Example</caption>
 * const fs = require('fs');
 * const path = require('path');
 *
 * async function streamExample() {
 *   const handler = new ResponseBuilder({
 *     protocol: PROTOCOLS.HTTP,
 *     streamTimeout: 15000,
 *     maxStreamSize: 10 * 1024 * 1024,
 *   });
 *
 *   try {
 *     const fileStream = fs.createReadStream(path.join(__dirname, 'large-file.txt'));
 *     const response = await handler.status(STATUS_CODES.ok).send(fileStream);
 *     console.log('Stream processed:', response);
 *   } catch (error) {
 *     if (error instanceof StreamTimeoutError) {
 *       console.error('Stream timed out after', error.timeout);
 *     } else if (error instanceof StreamSizeLimitError) {
 *       console.error('Stream too large:', error.actual);
 *     } else {
 *       console.error('Stream error:', error.message);
 *     }
 *   }
 * }
 *
 * @example <caption>4. Advanced Configuration</caption>
 * async function advancedConfigExample() {
 *   const handler = new ResponseBuilder({
 *     protocol: PROTOCOLS.HTTP,
 *     headers: { 'X-API-Version': '1.0', 'X-Custom-Header': 'MyApp' },
 *     streamTimeout: 30000,
 *     maxStreamSize: 100 * 1024 * 1024,
 *     contentType: 'application/json',
 *     errorHandler: (error) => {
 *       console.error('Custom error handler:', error.message);
 *       const customError = new Error(`Processed: ${error.message}`);
 *       customError.originalError = error;
 *       return customError;
 *     }
 *   });
 *
 *   const response = await handler
 *     .status(STATUS_CODES.created)
 *     .header('Location', '/api/users/123')
 *     .headers({ 'X-Request-ID': 'req-456' })
 *     .send({ id: 123, name: 'John Doe', email: 'john@example.com', createdAt: new Date() });
 *
 *   console.log('Advanced response:', response);
 * }
 *
 * @example <caption>5. Error Handling</caption>
 * async function errorHandlingExamples() {
 *   const handler = new ResponseBuilder();
 *   const responses = await Promise.allSettled([
 *     handler.send(null),
 *     handler.send('Hello World'),
 *     handler.send(42),
 *     handler.send(true),
 *     handler.send([1, 2, 3]),
 *     handler.send(new Date()),
 *     handler.send(new Error('Test error')),
 *     handler.send(Buffer.from('binary')),
 *     handler.send(new Map([['key', 'value']])),
 *     handler.send(new Set([1, 2, 3])),
 *   ]);
 *
 *   responses.forEach((result, index) => {
 *     if (result.status === 'fulfilled') {
 *       console.log(`Response ${index}:`, result.value);
 *     } else {
 *       console.error(`Error ${index}:`, result.reason.message);
 *     }
 *   });
 * }
 *
 * @example <caption>6. Content Type Detection</caption>
 *
 * const testCases = [
 *   '{"name": "John"}',
 *   '<html><body>Hello</body></html>',
 *   '<?xml version="1.0"?><root/>',
 *   '<svg></svg>',
 *   'body { color: red; }',
 *   'SGVsbG8gV29ybGQ=',
 *   'Hello World',
 *   ''
 * ];
 *
 * testCases.forEach(content => {
 *   const result = ResponseHelper.prepareBodyMetadata(content);
 *   console.log(`Type of "${content.substring(0, 20)}...":`, result.type);
 * });
 *
 * @example <caption>7. Stream Utilities</caption>
 * const fs = require('fs');
 * const zlib = require('zlib');
 * const { Transform } = require('stream');
 *
 * const fileStream = fs.createReadStream('test.txt');
 * const gzipStream = zlib.createGzip();
 * const transformStream = new Transform({
 *   transform(chunk, encoding, callback) {
 *     callback(null, chunk.toString().toUpperCase());
 *   }
 * });
 *
 * console.log(ResponseHelper.getStreamType(fileStream));
 * console.log(ResponseHelper.getStreamType(gzipStream));
 * console.log(ResponseHelper.getStreamType(transformStream));
 *
 * ResponseHelper.destroyStream(fileStream, true);
 * ResponseHelper.destroyStream(gzipStream, true);
 * ResponseHelper.destroyStream(transformStream, true);
 *
 * @example <caption>8. Express.js Integration</caption>
 * const express = require('express');
 *
 * const app = express();
 * app.use(express.json());
 *
 * app.get('/api/users/:id', async (req, res) => {
 *   try {
 *     const user = { id: req.params.id, name: 'John Doe' };
 *     const response = await httpResponder.ok(user);
 *     res.status(response.statusCode).set(response.headers).json(response.body);
 *   } catch (error) {
 *     const errResponse = await httpResponder.internalServerError({ error: error.message });
 *     res.status(errResponse.statusCode).json(errResponse.body);
 *   }
 * });
 *
 * app.post('/api/users', async (req, res) => {
 *   if (!req.body.email) {
 *     const response = await httpResponder.badRequest({ error: 'Email is required' });
 *     return res.status(response.statusCode).set(response.headers).json(response.body);
 *   }
 *   const newUser = { id: Date.now(), ...req.body };
 *   const response = await httpResponder.created(newUser, {
 *     headers: { Location: `/api/users/${newUser.id}` }
 *   });
 *   res.status(response.statusCode).set(response.headers).json(response.body);
 * });
 *
 * app.listen(3000, () => {
 *   console.log('Server running on port 3000');
 * });
 *
 * @example <caption>9. Custom Error Handler</caption>
 * const handler = new ResponseBuilder({
 *   errorHandler: (error) => {
 *     console.error('Stream error occurred:', {
 *       message: error.message,
 *       code: error.code,
 *       timestamp: new Date().toISOString()
 *     });
 *
 *     if (error.code === 'ENOENT') {
 *       const notFoundError = new Error('Resource not found');
 *       notFoundError.statusCode = 404;
 *       return notFoundError;
 *     }
 *     if (error.code === 'EACCES') {
 *       const forbiddenError = new Error('Access denied');
 *       forbiddenError.statusCode = 403;
 *       return forbiddenError;
 *     }
 *
 *     return null; // fallback to default error handler
 *   }
 * });
 *
 * try {
 *   const nonExistentStream = fs.createReadStream('non-existent-file.txt');
 *   await handler.send(nonExistentStream);
 * } catch (error) {
 *   console.log('Caught transformed error:', error.message);
 * }
 */
module.exports = {
  ResponseBuilder,
  ResponseHelper,
  PROTOCOLS,
  STATUS_CODES,
  // Export custom error classes
  StreamTimeoutError,
  StreamSizeLimitError,
  InvalidStatusCodeError,
  // Export protocol responders
  ...protocolExports,
};
