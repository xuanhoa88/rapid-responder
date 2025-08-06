# Adaptive Response Handler

A versatile JavaScript library designed for adaptive response handling across multiple communication protocols, including HTTP, 
IPC, and SOCKET. This library supports stream processing, MIME type detection, and advanced error handling to provide a robust 
solution for server-side or middleware applications.

---

## Table of Contents
- [Why use this?](#why-use-this)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Demo Output](#demo-output)
- [Usage](#usage)
  - [Importing the Module](#importing-the-module)
  - [HTTP/IPC/SOCKET Responders](#example-http-responder)
  - [Creating a Response Handler](#creating-a-response-handler)
  - [Setting Status Code](#setting-status-code)
  - [Handling Responses](#handling-responses)
- [TypeScript Usage](#typescript-usage)
- [Advanced Usage Examples](#advanced-usage-examples)
- [API Reference](#api-reference)
  - [Classes](#classes)
  - [Error Classes](#error-classes)
- [FAQ](#faq)
- [Development & Testing](#development--testing)
- [Contributing](#contributing)
- [License](#license)

---

## Why use this?
- **Unified API** for HTTP, IPC, and SOCKET responses
- **Automatic stream and content type handling**
- **Customizable error management**
- **Production-ready**: battle-tested for server/middleware use
- **Easy integration** with Express and other frameworks
- **TypeScript-friendly** (with JSDoc types)

---

## Features

- **Protocol Support**: Handles HTTP, IPC, and SOCKET responses seamlessly.
- **Stream Processing**: Detects and processes various stream types with built-in destruction and timeout handling.
- **MIME Type Detection**: Automatically identifies content types for responses.
- **Error Handling**: Customizable error handling with fallback mechanisms.
- **Status Management**: Built-in support for standard HTTP status codes.

---

## Installation

To install this package, use:

```bash
npm install rapid-responder
```

Or with Yarn:

```bash
yarn add rapid-responder
```

If you are using a monorepo (e.g., with workspaces):

```bash
yarn workspace <your-workspace-name> add rapid-responder
```

> **Note:** Requires Node.js v14 or higher.

---

## Quick Start

> **Note:** Top-level `await` is only available in ES modules or inside async functions. For CommonJS, wrap in an async function or use `.then()`.

```javascript
const { httpResponder } = require('rapid-responder');

async function main() {
  // Send a 200 OK HTTP response
  const response = await httpResponder.ok({ message: 'Hello, world!' });
  console.log(response);
  // {
  //   statusCode: 200,
  //   headers: { 'Content-Type': 'application/json', 'X-Response-Time': '...' },
  //   body: { message: 'Hello, world!' }
  // }
}

main();
```

---

## Demo Output

Example output for a successful HTTP response:

```json
{
  "statusCode": 200,
  "headers": {
    "Content-Type": "application/json",
    "X-Response-Time": "2024-06-01T12:34:56.789Z"
  },
  "body": {
    "message": "Hello, world!"
  }
}
```

---

## Usage

### Importing the Module

```javascript
const { ResponseBuilder, STATUS_CODES, PROTOCOLS, httpResponder, ipcResponder, socketResponder } = require('rapid-responder');
```

#### Example: HTTP Responder

```javascript
// Send an HTTP 200 OK response
httpResponder.ok({ message: 'Success' }, { headers: { 'Content-Type': 'application/json' } });

// Send an HTTP 404 Not Found response
httpResponder.notFound({ error: 'Resource not found' });
```

#### Example: IPC Responder

```javascript
// Send an IPC 201 Created response
ipcResponder.created({ id: 12345 });

// Send an IPC 500 Internal Server Error response
ipcResponder.internalServerError({ error: 'Unexpected error occurred' });
```

#### Example: SOCKET Responder

```javascript
// Send a SOCKET 503 Service Unavailable response
socketResponder.serviceUnavailable({ message: 'Service is temporarily down' });
```

---

### Creating a Response Handler

```javascript
const handler = new ResponseBuilder({
  protocol: PROTOCOLS.HTTP,
  headers: { 'Content-Type': 'application/json' },
  streamTimeout: 30000, // 30 seconds
  maxStreamSize: 50 * 1024 * 1024, // 50MB
});
```

### Setting Status Code

```javascript
handler.status(STATUS_CODES.ok);
```

### Handling Responses

#### Non-Stream Response

```javascript
async function example() {
  const handler = new ResponseBuilder();
  const response = await handler.send({ message: 'Hello, World!' });
  console.log(response);
  // {
  //   statusCode: 200,
  //   headers: { ... },
  //   body: { message: 'Hello, World!' }
  // }
}
```

#### Stream Response

```javascript
const fs = require('fs');
const readableStream = fs.createReadStream('./example.txt');

handler.send(readableStream).then(data => {
  console.log(data);
  // { body: <Buffer ...>, type: 'application/octet-stream', size: ... }
}).catch(error => {
  console.error(error);
});
```

---

## TypeScript Usage

```typescript
import { ResponseBuilder, STATUS_CODES, httpResponder } from 'rapid-responder';

async function main() {
  const handler = new ResponseBuilder({ protocol: 'http' });
  const response = await handler.status(STATUS_CODES.ok).send({ message: 'TS works!' });
  // response: { statusCode: number, headers: object, body: object }
  console.log(response);
}

main();
```

---

## Advanced Usage Examples

### Custom Error Handler

```javascript
const { ResponseBuilder, STATUS_CODES } = require('rapid-responder');

const handler = new ResponseBuilder({
  errorHandler: (error) => {
    console.error('Custom error handler:', error.message);
    const customError = new Error(`Processed: ${error.message}`);
    customError.originalError = error;
    return customError;
  }
});

(async () => {
  try {
    // Simulate a stream error
    const fs = require('fs');
    const nonExistentStream = fs.createReadStream('non-existent-file.txt');
    await handler.send(nonExistentStream);
  } catch (error) {
    console.log('Caught transformed error:', error.message);
  }
})();
```

### Stream Handling with Timeout and Size Limit

```javascript
const { ResponseBuilder, STATUS_CODES } = require('rapid-responder');
const fs = require('fs');

const handler = new ResponseBuilder({
  protocol: 'http',
  streamTimeout: 15000, // 15 seconds
  maxStreamSize: 10 * 1024 * 1024, // 10MB
});

(async () => {
  try {
    const fileStream = fs.createReadStream('./large-file.txt');
    const response = await handler.status(STATUS_CODES.ok).send(fileStream);
    console.log('Stream processed:', response);
  } catch (error) {
    if (error.code === 'STREAM_TIMEOUT') {
      console.error('Stream timed out after', error.timeout);
    } else if (error.code === 'STREAM_SIZE_LIMIT') {
      console.error('Stream too large:', error.actual);
    } else {
      console.error('Stream error:', error.message);
    }
  }
})();
```

### Content Type Detection

```javascript
const { ResponseHelper } = require('rapid-responder');

const testCases = [
  '{"name": "John"}',
  '<html><body>Hello</body></html>',
  '<?xml version="1.0"?><root/>',
  '<svg></svg>',
  'body { color: red; }',
  'SGVsbG8gV29ybGQ=',
  'Hello World',
  ''
];

testCases.forEach(content => {
  const result = ResponseHelper.prepareBodyMetadata(content);
  console.log(`Type of "${content.substring(0, 20)}...":`, result.type);
});
```

### Express.js Integration

```javascript
const express = require('express');
const { httpResponder } = require('rapid-responder');

const app = express();
app.use(express.json());

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = { id: req.params.id, name: 'John Doe' };
    const response = await httpResponder.ok(user);
    res.status(response.statusCode).set(response.headers).json(response.body);
  } catch (error) {
    const errResponse = await httpResponder.internalServerError({ error: error.message });
    res.status(errResponse.statusCode).json(errResponse.body);
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
```

---

## API Reference

### Classes

#### `ResponseBuilder`

##### Constructor

```javascript
new ResponseBuilder(options)
```
- `options`: Configuration object with the following properties:
  - `protocol` (string): Communication protocol (default: `PROTOCOLS.HTTP`).
  - `headers` (object): Response headers.
  - `streamTimeout` (number): Timeout for stream processing (default: `30000ms`).
  - `maxStreamSize` (number): Maximum allowable size for streams (default: `50MB`).
  - `contentType` (string): Override content type.
  - `errorHandler` (function): Custom error handler.

##### Methods

- **`status(code)`**
  - Sets the HTTP status code for the response.
  - Returns the `ResponseBuilder` instance for chaining.

- **`header(name, value)`**
  - Sets a single header.
  - Returns the `ResponseBuilder` instance for chaining.

- **`headers(headers)`**
  - Sets multiple headers.
  - Returns the `ResponseBuilder` instance for chaining.

- **`send(body)`**
  - Processes the response body and returns a formatted object or Promise.

### Error Classes

- **`StreamTimeoutError`**: Thrown when a stream exceeds the configured timeout.
- **`StreamSizeLimitError`**: Thrown when a stream exceeds the maximum allowed size.
- **`InvalidStatusCodeError`**: Thrown when an invalid status code is set.

### Other Exports
- `ResponseHelper`: Utility class for content/stream type detection.
- `PROTOCOLS`, `STATUS_CODES`: Enum objects for protocols and status codes.
- `httpResponder`, `ipcResponder`, `socketResponder`: Protocol-specific responder objects.

---

## FAQ

**Q: Why do I get a stream timeout error?**
- A: The stream did not finish within the configured `streamTimeout` (default: 30s). Increase the timeout or check your stream source.

**Q: How do I set a custom content type?**
- A: Use the `contentType` option in `ResponseBuilder` or set the `Content-Type` header.

**Q: Can I use this with TypeScript?**
- A: Yes! The library is JSDoc-typed and works well with TypeScript projects.

**Q: How do I handle binary data?**
- A: If you send a `Buffer` or stream, the response will be `application/octet-stream` by default.

---

## Development & Testing

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd rapid-responder
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run tests:
   ```bash
   npm test
   ```
4. Lint code:
   ```bash
   npm run lint
   ```

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a feature branch.
3. Make your changes with clear commit messages.
4. Ensure all tests pass and code is linted.
5. Submit a pull request with a detailed description.

---

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

---

## Acknowledgments

- Built with ❤️ for the JavaScript community.
- Inspired by common challenges in handling adaptive responses.