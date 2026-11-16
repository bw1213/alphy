import { describe, expect, it } from "vitest";
import { keyFor, uidFromCookie } from "@/lib/client/userStorage";

describe("브라우저 저장값 이름 (사람별)", () => {
  it("owner 는 예전 이름 그대로, 다른 사람은 뒤에 아이디가 붙음", () => {
    expect(keyFor("alphy.last-state", "owner")).toBe("alphy.last-state");
    expect(keyFor("alphy.last-state", "mom")).toBe("alphy.last-state:mom");
  });
  it("쿠키에서 아이디를 읽고, 없거나 이상하면 owner", () => {
    expect(uidFromCookie("a=1; alphy_uid=mom; b=2")).toBe("mom");
    expect(uidFromCookie("")).toBe("owner");
    expect(uidFromCookie("alphy_uid=../x")).toBe("owner");
    expect(uidFromCookie("alphy_uid=" + encodeURIComponent("<script>"))).toBe("owner");
  });
});
