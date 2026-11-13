import type { MetadataRoute } from "next";

/** 검색 엔진에 올라가지 않게 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
