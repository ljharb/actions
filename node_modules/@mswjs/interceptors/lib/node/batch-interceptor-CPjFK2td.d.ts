import { t as Interceptor } from "./interceptor-dtJZ_9QT.js";
import { DefaultEventMap } from "rettime";
//#region src/batch-interceptor.d.ts
interface BatchInterceptorOptions<InterceptorList extends ReadonlyArray<Interceptor<DefaultEventMap>>> {
  name: string;
  interceptors: InterceptorList;
}
type UnionToIntersection<Union> = (Union extends unknown ? (argument: Union) => void : never) extends ((argument: infer Intersection) => void) ? Intersection : never;
/**
 * @note Merge the event maps of all the given interceptors into
 * an intersection. A naive conditional type distributes over the
 * interceptor union, producing a union of event maps whose `keyof`
 * is `never` (no common keys), which would make `.on()` unusable.
 */
type ExtractEventMapType<InterceptorList extends ReadonlyArray<Interceptor<DefaultEventMap>>> = InterceptorList extends ReadonlyArray<infer InterceptorType> ? UnionToIntersection<InterceptorType extends Interceptor<infer EventMap> ? EventMap : never> : never;
/**
 * A batch interceptor that exposes a single interface
 * to apply and operate with multiple interceptors at once.
 */
declare class BatchInterceptor<InterceptorList extends ReadonlyArray<Interceptor<DefaultEventMap>>, Events extends DefaultEventMap = ExtractEventMapType<InterceptorList>> extends Interceptor<Events> {
  #private;
  constructor(options: BatchInterceptorOptions<InterceptorList>);
  protected predicate(): boolean;
  protected setup(): void;
}
//#endregion
export { BatchInterceptor as t };
//# sourceMappingURL=batch-interceptor-CPjFK2td.d.ts.map