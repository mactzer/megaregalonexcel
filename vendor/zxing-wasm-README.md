The local reader is the unmodified IIFE reader from `zxing-wasm@3.1.5`,
https://github.com/Sec-ant/zxing-wasm, licensed under MIT. The WebAssembly
reader uses ZXing-C++, licensed under Apache 2.0. Both licenses are included.
No barcode images or camera frames are sent to a remote decoding service.

To reproduce the vendored files, install `zxing-wasm@3.1.5` outside the checkout
using npm with TLS and integrity checks enabled. Copy its
`dist/iife/reader/index.js` to `zxing-wasm-reader.js`,
`dist/reader/zxing_reader.wasm` to `zxing_reader.wasm`, and its `LICENSE`.

SHA-256:

```
228e6d8ccb841c544386eeafd5f18294d3e4aa0e7aa20419bc51a0009b9d3c17  zxing-wasm-reader.js
aecc1876de036c62c8419f67a5e1a16b1698a325bcd190aa84810d516e263931  zxing_reader.wasm
```
