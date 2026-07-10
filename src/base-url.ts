const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

export function publicUrl(path: string): string {
  return `${base}${path.replace(/^\/+/, "")}`;
}

export function appHref(path = "/"): string {
  const normalized = path.replace(/^\/+/, "");
  return normalized ? `${base}${normalized}` : base;
}

export const isStaticDeploy = import.meta.env.VITE_STATIC_DEPLOY === "true";
