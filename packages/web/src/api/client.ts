export const API_BASE = "/api/v1";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

/** Status for failures that never reached the server. */
export const NETWORK_ERROR_STATUS = 0;

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(
      NETWORK_ERROR_STATUS,
      "NETWORK",
      "Can't reach the server. Check your connection and try again.",
    );
  }
}

async function errorFrom(response: Response): Promise<ApiRequestError> {
  const data = await response.json().catch(() => null);
  return new ApiRequestError(
    response.status,
    data?.error?.code ?? "INTERNAL",
    data?.error?.msg ?? `The server returned an error (${response.status})`,
  );
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await send(method, path, body);
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  return (await response.json().catch(() => null)) as T;
}

function filenameFrom(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

/** POSTs a request and saves the response body as a file. */
export async function downloadFile(path: string, body: unknown, fallbackName: string) {
  const response = await send("POST", path, body);
  if (!response.ok) throw await errorFrom(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFrom(response, fallbackName);
  a.click();
  // Some browsers cancel the download if the URL is revoked during the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
