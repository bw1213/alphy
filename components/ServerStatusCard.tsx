"use client";

import { useCallback, useEffect, useState } from "react";

interface Status {
  users: { total: number; admins: number; disabled: number; totpEnabled: number; realOrdersAllowed: number; pendingInvites: number };
  load: { active: number; queued: number; maxActive: number; maxQueue: number };
  rate: { max: number; minutes: number };
  config: { files: number; bytes: number; newest: string | null };
  secretFromEnv: boolean;
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
        <li>한 사람이 {st.rate.minutes}분 동안 시세를 받을 수 있는 횟수: {st.rate.max}번</li>
        <li>설정 폴더: 파일 {st.config.files}개, {(st.config.bytes / 1024).toFixed(0)}KB{st.config.newest ? `, 마지막 변경 ${new Date(st.config.newest).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" })}` : ""}</li>
        <li>다른 사람 앱키 암호화 키: {st.secretFromEnv ? <span className="badge ok">환경변수(ALPHY_SECRET_KEY)</span> : <>자동 생성 파일(<code>secret.key</code>)</>}</li>
      </ul>
      <p className="help" style={{ marginTop: 8 }}>
        NAS가 느려서 시세 받기는 한 번에 {st.load.maxActive}건만 처리하고 나머지는 줄을 세웁니다. 백테스트 계산 자체는 각자의 브라우저에서 돌기 때문에 사람이 늘어도 NAS 부담은 시세 받기뿐입니다.
      </p>
      <p className="help">
        <b>백업</b>: 계정·초대·전략·한국투자증권 키가 모두 <code>docker/alphy/nas/cache/config</code> 폴더에 있습니다. DSM의 Hyper Backup으로 이 폴더를 주 1회 이상, 암호화를 켜서 백업해 두세요.
        {st.secretFromEnv
          ? <> 암호화 키는 NAS <code>.env</code> 에 있으므로 <code>.env</code> 도 따로 보관해야 복원할 수 있습니다.</>
          : <> 이 폴더 안의 <code>secret.key</code> 가 없으면 다른 사람이 넣은 앱키를 풀 수 없으니 함께 백업됩니다.</>}
        {" "}시세 캐시(<code>nas/cache</code> 의 나머지)는 다시 받을 수 있어 백업하지 않아도 됩니다.
      </p>
    </div>
  );
}
