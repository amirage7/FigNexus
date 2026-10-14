import {ensureBridge} from '../../../packages/mcp-server/src/launcher';
try{await ensureBridge();console.error('本机服务已就绪。在 Figma 插件点击“配对本机”，六位码确认窗口会自动出现，无需单独启动助手。');}
catch{console.error('本机服务未能启动。请确认安装完成；若旧版本服务仍运行，请先关闭你自己的旧服务后重试。');process.exitCode=1;}
