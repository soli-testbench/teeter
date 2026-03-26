# Plan: Fix CSP Blocking Inline Importmap

## Problem

The game fails to load because a Content Security Policy directive `script-src 'self' https://cdn.jsdelivr.net` blocks the inline `<script type="importmap">` in `index.html`. The importmap must be inline (browsers don't support external importmaps via `src`), so we need to allow it via CSP hash.

## Root Cause

The inline importmap at line 259 of `index.html` is blocked by CSP. The browser helpfully provides the exact SHA-256 hash needed: `sha256-Cb7VRvgKHYvwTusy6WvuTr1ww8fUTjYTnEACYzG5a/8=`. Verified by computing the hash of the importmap content.

## Fix

Add a `Content-Security-Policy` header in `nginx.conf` that:
1. Allows `'self'` scripts and `https://cdn.jsdelivr.net` (for Three.js CDN)
2. Allows the inline importmap via its SHA-256 hash
3. Allows inline styles (the page uses a `<style>` block)

The header to add in the `server` or `location /` block:

```
add_header Content-Security-Policy "script-src 'self' https://cdn.jsdelivr.net 'sha256-Cb7VRvgKHYvwTusy6WvuTr1ww8fUTjYTnEACYzG5a/8='; style-src 'self' 'unsafe-inline'; default-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self';" always;
```

## Files Changed

- `nginx.conf` — Add CSP header with importmap hash

## Scope

Single file, ~1 line change. No logic changes. Quality: skip.
