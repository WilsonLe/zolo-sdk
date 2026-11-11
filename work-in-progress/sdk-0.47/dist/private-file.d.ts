/** Internal credential-file I/O shared by Web and Desktop stores. */
export declare function readPrivateFile(path: string, label: string, maxBytes?: number): Promise<string | null>;
export declare function writePrivateFile(path: string, content: string, label: string): Promise<void>;
export declare function clearPrivateFile(path: string, label: string): Promise<void>;
