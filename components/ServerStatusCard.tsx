"use client";

import { useCallback, useEffect, useState } from "react";
import Info from "@/components/Info";

interface Status {
  users: { total: number; admins: number; disabled: number; totpEnabled: number; realOrdersAllowed: number; pendingInvites: number };
  load: { active: number; queued: number; maxActive: number; maxQueue: number };
  runner?: boolean;
  rate: { max: number; minutes: number };
  config: { files: number; bytes: number; newest: string | null };
  memoryMb: number;
}

/** 설정 화면 "관리" 구역: 서버 상태와 백업 안내 (관리자만) */
export default function ServerStatusCard() {
  const [st, setSt] = useState<Status | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/status", { cache: "no-store" });
    if (r.ok) setSt(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!st) return null;
  const u = st.users;
  return (
    <div className="card wide">
      <h2>서버 상태 · 백업</h2>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
        <li>사용자 {u.total}명 (관리자 {u.admins}명{u.disabled ? `, 정지 ${u.disabled}명` : ""}) · 2단계 인증 켠 사람 {u.totpEnabled}명 · 실전 주문 허용 {u.realOrdersAllowed}명 · 안 쓴 초대 {u.pendingInvites}개</li>
        <li>지금 시세 받는 요청: {st.load.active}건 실행 중, {st.load.queued}건 대기 (한 번에 {st.load.maxActive}건, 대기 {st.load.maxQueue}건까지) · 메모리 {st.memoryMb}MB</li>
        <li>전략 코드 실행: {st.runner ? "별도 전략 실행기 컨테이너 (비밀값·인터넷 없음)" : "본체 안 격리 공간"}{!st.runner && <Info>docker-compose.yml 의 alphy-runner 를 NAS 프로젝트에 추가하면 사용자 전략 코드가 별도 컨테이너에서 돌아 더 안전합니다.</Info>}</li>
        <li>한 사람이 {st.rate.minutes}분 동안 시세를 받을 수 있는 횟수: {st.rate.max}번</li>
        <li>설정 폴더: 파일 {st.config.files}개, {(st.config.bytes / 1024).toFixed(0)}KB{st.config.newest ? `, 마지막 변경 ${new Date(st.config.newest).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" })}` : ""}</li>
      </ul>
      <p className="help" style={{ marginTop: 8 }}>
        <b>백업</b>: <code>docker/alphy/nas/cache/config</code> 폴더를 Hyper Backup으로 암호화해 백업하세요.<Info>계정·초대·전략·한국투자증권 키가 모두 이 폴더에 있습니다.
        {" "}이 폴더 안의 <code>secret.key</code> 가 없으면 다른 사람이 넣은 앱키를 풀 수 없으니 함께 백업됩니다.
        {" "}시세 캐시는 백업하지 않아도 됩니다.</Info>
      </p>
    </div>
  );
}
