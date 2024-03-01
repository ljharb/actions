declare module 'get-json' {
    function getJSON<T extends object>(url: string): Promise<T>;

    export = getJSON;
}