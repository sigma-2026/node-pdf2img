// 工具函数：解析 JSON 参数
const parseJsonParam = (param) => {
  if (!param) return null;
  return typeof param === 'string' ? JSON.parse(param) : param;
};

// 工具函数：验证 URL 格式
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

export { parseJsonParam, isValidUrl };
