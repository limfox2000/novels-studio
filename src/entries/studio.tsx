/** #/studio 创作台入口（独立 bundle）：地图画布 + 规则/目标 + 卷/章节大纲/正文 + 编辑室。 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../index.css';
import { StudioPage } from '../components/studio/StudioPage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StudioPage />
  </React.StrictMode>,
);
