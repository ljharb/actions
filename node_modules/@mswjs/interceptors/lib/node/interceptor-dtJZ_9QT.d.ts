import { DefaultEventMap, Emitter } from "rettime";
//#region src/disposable.d.ts
type DisposableSubscription = () => void;
declare class Disposable {
  protected subscriptions: Array<DisposableSubscription>;
  dispose(): void;
}
//#endregion
//#region src/utils/logger.d.ts
type LogLevel = 'default' | 'verbose';
interface Logger {
  info(message: string, ...positionals: Array<unknown>): void;
  verbose(message: string, ...positionals: Array<unknown>): void;
  isEnabled(level: LogLevel): boolean;
}
//#endregion
//#region src/interceptor.d.ts
declare enum InterceptorReadyState {
  INACTIVE = "INACTIVE",
  ACTIVE = "ACTIVE",
  DISPOSED = "DISPOSED"
}
declare global {
  var __MSW_INTERCEPTORS_REGISTRY: Map<symbol, Interceptor<any>> | undefined;
}
declare abstract class Interceptor<Events extends DefaultEventMap> extends Disposable {
  #private;
  ['constructor']: typeof Interceptor;
  protected emitter: Emitter<Events>;
  protected readonly logger: Logger;
  readyState: InterceptorReadyState;
  static readonly symbol: symbol;
  static singleton<T extends Interceptor<any>>(InterceptorClass: (new () => T) & {
    symbol: symbol;
  }): T;
  constructor();
  protected abstract predicate(): boolean;
  protected abstract setup(): void;
  apply(owner?: object): void;
  dispose(owner?: object): void;
  on: Emitter<Events>['on'];
  once: Emitter<Events>['once'];
  listeners: Emitter<Events>['listeners'];
  listenerCount: Emitter<Events>['listenerCount'];
  removeListener: Emitter<Events>['removeListener'];
  removeAllListeners: Emitter<Events>['removeAllListeners'];
}
//#endregion
export { Logger as n, Interceptor as t };
//# sourceMappingURL=interceptor-dtJZ_9QT.d.ts.map