/** 서버가 켜질 때 한 번 실행 (Next.js). 자동 매매 예약 실행기를 시작합니다. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("./lib/auto/scheduler");
  startScheduler();
}
