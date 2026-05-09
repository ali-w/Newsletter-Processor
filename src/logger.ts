export const logger = {
  info:  (msg: string, data?: object) => console.log(JSON.stringify({ severity: 'INFO',    message: msg, ...data })),
  warn:  (msg: string, data?: object) => console.log(JSON.stringify({ severity: 'WARNING', message: msg, ...data })),
  error: (msg: string, data?: object) => console.error(JSON.stringify({ severity: 'ERROR', message: msg, ...data })),
};
