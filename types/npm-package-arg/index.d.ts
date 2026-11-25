declare module 'npm-package-arg' {
    function npa(arg: string): { escapedName?: string | null };

    export default npa;
}
