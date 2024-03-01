declare module 'cache/dist/save' {
    function save(): Promise<void>;

    export default save;
}

declare module 'cache/dist/restore' {
    function restore(): Promise<void>;

    export default restore;
}