declare module 'npm-registry-fetch' {
    const registryFetch: {
        json(uri: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    export default registryFetch;
}
