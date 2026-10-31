// An error answered by the admin's file API, or by the browser's own store
// (local-store.js) in the same shape: status, code, the current version.

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error ?? `HTTP ${status}`);
    this.status = status;
    this.code = data?.code;
    this.current = data?.current;
    this.assets = data?.assets;
  }
}
