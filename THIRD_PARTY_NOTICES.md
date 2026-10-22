# Third-Party Notices

AutoSwitch has no npm runtime dependencies. Its implementation and protocol knowledge draw on the following MIT-licensed community projects. Their copyright notices are reproduced below. No source files were copied verbatim except protocol constants and request-header/format details required for interoperability.

## Node.js (bundled runtime)

- Project: https://nodejs.org/
- Copyright Node.js contributors. All rights reserved.
- The Windows installer and portable ZIP bundle the official `node.exe` from the build machine's Node.js **24.14.1** installation. Node.js is distributed under the MIT license with additional third-party notices. The complete license text is included in the installer as `node-LICENSE.txt`.

## WorkBuddy-Switch

- Repository: https://github.com/koi128bit/WorkBuddy-Switch
- Copyright (c) 2026 koi128bit
- Used for: product shape, local web/desktop panel ideas, provider adapter separation, encrypted account storage and scheduling UX.

## CreditDaddy

- Repository: https://github.com/techysy/CreditDaddy
- Copyright (c) 2026 CreditDaddy contributors
- Used for: Qoder Electron `safeStorage` decryption flow, Qoder runtime-info risk headers, Qoder device-code login, Trae `tc` envelope constants/decryption, Trae request headers, device-ID strategy, and Trae login-state snapshot whitelist.

## workbuddy-auto-signin

- Repository: https://github.com/88lin/workbuddy-auto-signin
- Copyright (c) 2026 88lin
- Used for: Qoder CN campaign/claim endpoint behavior and runtime-info device identity handling.

## 10router

- Repository: https://github.com/decolua/10router
- Copyright (c) 2024-2026 decolua, techysy and contributors
- Used for: Qoder device-token (PKCE + nonce) login flow.

## Trae daily check-in (reference only)

- Repository: https://github.com/BlueChonk/trae-daily-checkin
- No license file was present at the time of reference; only the public client structure and CDP exploration approach were consulted, and no code is included.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
