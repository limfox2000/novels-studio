/** 🚪 推演通道边：环境 ↔ 环境之间的门/路径（画布连线 = 空间拓扑）。
 *
 *  数据在 edge.data（见 SimPortalData）：name/locked/traverseCost/oneWay/waypoint。
 *  锁闭显示 🔒 + 红色虚线；单向显示方向箭头；名称显示在连线上。
 *  推演建世界时由 simWorld.buildSimWorld 读取（与渲染无关）。 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

export function SimPortalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const d = (data ?? {}) as { name?: unknown; locked?: unknown };
  const locked = d.locked === true;
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: locked ? '#f43f5e' : selected ? '#4f46e5' : '#94a3b8',
          strokeWidth: selected ? 2.5 : 2,
          strokeDasharray: locked ? '6 4' : undefined,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          data-sim-portal-edge={id}
          className={`nodrag nopan pointer-events-none absolute rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] leading-none shadow-sm ring-1 ${
            locked ? 'text-rose-600 ring-rose-200' : 'text-slate-500 ring-slate-200'
          }`}
          style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
          title={locked ? '通道已锁闭（推演中不可通过）' : '通道（门/路径）'}
        >
          {locked ? '🔒' : '🚪'}
          {name ? <span className="ml-0.5">{name}</span> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
