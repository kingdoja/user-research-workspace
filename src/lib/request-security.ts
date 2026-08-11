export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");

  if (!origin) {
    return true;
  }

  return new URL(origin).origin === new URL(request.url).origin;
}

export function safeCallbackPath(value: string | null | undefined, fallback = "/newstudy") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  return value;
}
