export interface ObjectInfo {
    oid: string;
    type: string;
    size: number;
}
export interface ObjectContents extends ObjectInfo {
    data: Buffer;
}
export declare class CatFileProcess {
    private proc;
    private buffer;
    private queue;
    private closed;
    private requestChain;
    constructor(cwd: string);
    private tryFlush;
    private sendCommand;
    private enqueue;
    info(oid: string): Promise<ObjectInfo | null>;
    contents(oid: string): Promise<ObjectContents | null>;
    close(): void;
}
//# sourceMappingURL=cat-file-process.d.ts.map