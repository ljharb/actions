declare function mockProperty<O extends object, K extends PropertyKey>(
    obj: O,
    prop: K,
    options: mockProperty.MockPropertyOptions<K extends keyof O ? O[K] : unknown>,
): mockProperty.RestoreFunction;

declare namespace mockProperty {
    export type Getter<T> = (() => void) | (() => T);
    export type Setter<T> = (v: T) => void;

    export type OptionAccessor<T = unknown> = {
        delete?: false;

        nonConfigurable?: boolean;
        nonEnumerable?: boolean;

        get?: Getter<T>;
        set?: Setter<T>;

        nonWritable?: never;
        value?: never;
    };

    export type OptionData<T = unknown> = {
        delete?: false;

        nonConfigurable?: boolean;
        nonEnumerable?: boolean;

        get?: never;
        set?: never;

        nonWritable?: boolean;
        value?: T;
    };

    export type OptionDelete = {
        delete: true;

        nonConfigurable?: boolean;
        nonEnumerable?: never;

        get?: never;
        set?: never;

        nonWritable?: never;
        value?: never;
    };

    export type MockPropertyOptions<T = unknown> =
        | OptionDelete
        | OptionData<T>
        | OptionAccessor<T>;

    export type RestoreFunction = () => void;
}

export = mockProperty;
