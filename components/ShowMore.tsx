"use client";

import { useState } from "react";

/** 로그처럼 시간순으로 쌓이는 목록: 처음엔 5줄만, "더보기"를 누를 때마다 더 보여 준다. */
export const LOG_ROWS = 5;
const STEP = 10;

export function useShowMore<T>(list: T[], first = LOG_ROWS) {
  const [count, setCount] = useState(first);
  const shown = list.slice(0, count);
  const rest = Math.max(0, list.length - count);
  const more = (
    <ShowMoreButtons
      rest={rest}
      expanded={count > first && list.length > first}
      onMore={() => setCount((c) => c + STEP)}
      onFold={() => setCount(first)}
    />
  );
  return { shown, more };
}

function ShowMoreButtons({ rest, expanded, onMore, onFold }: { rest: number; expanded: boolean; onMore: () => void; onFold: () => void }) {
  if (rest === 0 && !expanded) return null;
  return (
    <div className="btns" style={{ marginTop: 8 }}>
      {rest > 0 && <button onClick={onMore}>더보기 ({rest}개 더 있음)</button>}
      {expanded && <button onClick={onFold}>접기</button>}
    </div>
  );
}
