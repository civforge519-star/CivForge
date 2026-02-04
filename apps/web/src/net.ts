export const buildHttpBase = (url: string): string => url.replace(/\/+$/, "");

export const buildWsUrl = (rawUrl: string): string => {
  let url = rawUrl.trim();
  if (url.startsWith("http://")) {
    url = url.replace("http://", "ws://");
  }
  if (url.startsWith("https://")) {
    url = url.replace("https://", "wss://");
  }
  if (typeof window !== "undefined" && window.location.protocol === "https:" && url.startsWith("ws://")) {
    url = url.replace("ws://", "wss://");
  }
  return url;
};

export const safeParseJson = <T>(input: string): T | null => {
  try {
    return JSON.parse(input) as T;
  } catch (error) {
    return null;
  }
};

