This directory preserves the TypeScript implementation and its tests as a migration reference. It is test-only: the executable, HTTP server, stdio MCP server and browser tests use the native Go implementation.

Keep this reference fixed except for test harness paths. New behavior and regression tests belong in `internal/coral` and the browser suite. The native parity tests compare the two implementations through public Web and MCP interfaces; passing the reference tests alone does not validate the Go backend.
