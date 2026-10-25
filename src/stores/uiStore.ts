import { create } from 'zustand';
import { readSavedActiveChapterId } from './activeChapter';

export type DialogState =
  | { type: 'advance' | 'focus'; cardId: string }
  | { type: 'supplement' } // 补充节点独立创建
  | { type: 'event' } // 事件节点独立创建，不依附任何卡片
  | { type: 'start' }; // 初始节点独立创建（多线剧情/多角色入口）

interface UiState {
  dialog: DialogState | null;
  generating: boolean;
  sidebarOpen: boolean;
  globalsPanelOpen: boolean;
  timelineOpen: boolean;
  promptPreviewOpen: boolean;
  graphListOpen: boolean;
  /** 模型中心（文本/推理/生图统一配置）面板开关；不持久化，重开页面默认关闭 */
  modelCenterOpen: boolean;
  saveStatus: 'idle' | 'unsaved' | 'saved' | 'error';
  saveMsg: string;
  /** 📐 当前章节：大纲/正文面板与画布区域高亮共用（不持久化，重开页面回落到首章） */
  activeChapterId: string | null;
  /** 当前选中的章节区域（画布注释，不是节点） */
  selectedRegionId: string | null;
  /** 正在绘制的章节区域所属章节；null=未处于绘制模式 */
  regionDrawChapterId: string | null;
  /** 是否显示章节区域覆盖层 */
  regionsVisible: boolean;
  /** 请求把某区域滚到视野中心；nonce 递增保证重复点击也触发 */
  regionFocus: { regionId: string; nonce: number } | null;

  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
  setGenerating: (v: boolean) => void;
  toggleSidebar: () => void;
  toggleGlobalsPanel: () => void;
  toggleTimeline: () => void;
  setPromptPreviewOpen: (v: boolean) => void;
  setGraphListOpen: (v: boolean) => void;
  setModelCenterOpen: (v: boolean) => void;
  setSaveStatus: (s: UiState['saveStatus'], msg?: string) => void;
  setActiveChapterId: (id: string | null) => void;
  setSelectedRegionId: (id: string | null) => void;
  startRegionDraw: (chapterId: string) => void;
  cancelRegionDraw: () => void;
  setRegionsVisible: (v: boolean) => void;
  requestRegionFocus: (regionId: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  dialog: null,
  generating: false,
  sidebarOpen: true,
  globalsPanelOpen: true,
  timelineOpen: false,
  promptPreviewOpen: false,
  graphListOpen: false,
  modelCenterOpen: false,
  saveStatus: 'idle',
  saveMsg: '',
  activeChapterId: readSavedActiveChapterId(),
  selectedRegionId: null,
  regionDrawChapterId: null,
  regionsVisible: true,
  regionFocus: null,

  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: null }),
  setGenerating: (v) => set({ generating: v }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleGlobalsPanel: () => set((s) => ({ globalsPanelOpen: !s.globalsPanelOpen })),
  toggleTimeline: () => set((s) => ({ timelineOpen: !s.timelineOpen })),
  setPromptPreviewOpen: (v) => set({ promptPreviewOpen: v }),
  setGraphListOpen: (v) => set({ graphListOpen: v }),
  setModelCenterOpen: (v) => set({ modelCenterOpen: v }),
  setSaveStatus: (s, msg) => set({ saveStatus: s, saveMsg: msg ?? '' }),
  setActiveChapterId: (id) => set({ activeChapterId: id }),
  setSelectedRegionId: (id) => set({ selectedRegionId: id }),
  startRegionDraw: (chapterId) =>
    set({ regionDrawChapterId: chapterId, selectedRegionId: null, regionsVisible: true }),
  cancelRegionDraw: () => set({ regionDrawChapterId: null }),
  setRegionsVisible: (v) => set({ regionsVisible: v }),
  requestRegionFocus: (regionId) =>
    set((s) => ({ regionFocus: { regionId, nonce: (s.regionFocus?.nonce ?? 0) + 1 } })),
}));
