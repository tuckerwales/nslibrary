# Keys (`prod.keys`)

NSLibrary never ships or fetches title keys. The only keys it uses are the ones you dump from **your own** console, typically with [Lockpick_RCM](https://gbatemp.net/download/lockpick_rcm-1-9-15-fw-20-zoria.39129/).

## What they are for

Without keys, the library still works: it reads container listings, tickets, and filenames. Names, icons, firmware requirements, and content hashes come from CNMT and control NCAs, which need:

- `header_key` — decrypt NCA headers
- `key_area_key_application_XX` (and ocean/system) — unwrap the NCA key area
- `titlekek_XX` — decrypt common title keys from tickets

`XX` is the master-key generation as two hex digits (`00`, `0a`, …).

## Where they are stored

Uploaded through **Settings** in the web UI (or `PUT /api/v1/keys`). Saved at:

```
<dataDir>/keys/prod.keys
```

File mode is `0600`. The API reports which **names** are present. Key material is never returned, logged, or sent to a Switch.

Docker: `/data/keys/prod.keys`. Electron: under the app user-data directory.

## Filename mode

If a needed key is missing, that file stays in filename/ticket mode and is labelled unverified. The rest of the library is unchanged.
