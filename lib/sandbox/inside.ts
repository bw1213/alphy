import { runBacktest, type RunOptions } from "../engine/engine";
import { dividendTaxFn } from "../engine/dividends";
import { compileStrategy, type Params } from "../strategies";

export interface SandboxJob {
  opts: Omit<RunOptions, "strategy" | "dividendTax">;
  taxKr?: number;
  code: string;
  params: Params;
}

(globalThis as any).__alphyRun = (job: SandboxJob) => {
  const fn = compileStrategy(job.code);
  return runBacktest({
    ...job.opts,
    ...(job.taxKr != null ? { dividendTax: dividendTaxFn(job.taxKr) } : {}),
    strategy: (ctx) => fn(ctx, job.params),
  });
};
