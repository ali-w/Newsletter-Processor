declare module 'node-pop3' {
  export default class Pop3Command {
    constructor(options: any);
    connect(): Promise<void>;
    command(cmd: string, ...args: any[]): Promise<any>;
    UIDL(msgNum?: string | number): Promise<string[][]>;
    RETR(msgNum: string | number): Promise<string>;
    TOP(msgNum: string | number, n?: number): Promise<string>;
    QUIT(): Promise<string>;
  }
}
