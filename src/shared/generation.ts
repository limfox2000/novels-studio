/** 全局生成互斥（原在 services/graphSync，多入口拆分后独立成共享模块）：
 *  同一时刻仅一个生成任务，startGeneration 发新信号，stopGeneration 中止之。
 *  studio 与 novelsim 各自页面（独立 document）内共享本模块状态；跨页互斥不存在（此前 hash 路由同文档共享，属历史行为）。 */

let controller: AbortController | null = null;

export function startGeneration(): AbortSignal {
  controller = new AbortController();
  return controller.signal;
}

export function stopGeneration(): void {
  controller?.abort();
}

/** 生成被用户中止（qwenClient 与各引擎共用；移到共享层避免依赖各页面专属模块） */
export class GenerationAborted extends Error {
  constructor() {
    super('生成已停止');
    this.name = 'GenerationAborted';
  }
}
