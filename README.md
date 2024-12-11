# Adaptive Response Handler

A versatile JavaScript library designed for adaptive response handling across multiple communication protocols, including HTTP, IPC, and SOCKET. This library supports stream processing, MIME type detection, and advanced error handling to provide a robust solution for server-side or middleware applications.

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

---

## Usage

### Importing the Module

```javascript
const { ResponseHandler, STATUS_CODES, PROTOCOLS, httpResponder, ipcResponder, socketResponder } = require('rapid-responder');
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
const handler = new ResponseHandler({
  protocol: PROTOCOLS.HTTP,
  headers: { 'Content-Type': 'application/json' },
  streamTimeout: 30000,
  maxStreamSize: 50 * 1024 * 1024,
});
```

### Setting Status Code

```javascript
handler.status(STATUS_CODES.ok);
```

### Handling Responses

#### Non-Stream Response

```javascript
const response = handler.send({ message: 'Hello, World!' });
console.log(response);
```

#### Stream Response

```javascript
const fs = require('fs');
const readableStream = fs.createReadStream('./example.txt');

handler.send(readableStream).then(data => {
  console.log(data);
}).catch(error => {
  console.error(error);
});
```

---

## API Reference

### Classes

#### `ResponseHandler`

##### Constructor

```javascript
new ResponseHandler(options)
```
- `options`: Configuration object with the following properties:
  - `protocol` (string): Communication protocol (default: `PROTOCOLS.HTTP`).
  - `headers` (object): Response headers.
  - `streamTimeout` (number): Timeout for stream processing (default: `30000ms`).
  - `maxStreamSize` (number): Maximum allowable size for streams (default: `50MB`).

##### Methods

- **`status(code)`**
  - Sets the HTTP status code for the response.
  - Returns the `ResponseHandler` instance for chaining.

- **`send(body)`**
  - Processes the response body and returns a formatted object or Promise.

---

## Contributing

Contributions are welcome! Please follow the guidelines:

1. Fork the repository.
2. Create a feature branch.
3. Submit a pull request with a detailed description of your changes.

---

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.

---

## Acknowledgments

- Built with ❤️ for the JavaScript community.
- Inspired by common challenges in handling adaptive responses.

---

## Contact

For issues or inquiries, contact the maintainer at `xuan.0211@gmail.com`.