import { create } from 'zustand';

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
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveMsg: string;

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
}));
