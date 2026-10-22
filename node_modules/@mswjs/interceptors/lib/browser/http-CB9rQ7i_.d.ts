import { n as Logger } from "./interceptor-dtJZ_9QT.js";
import { TypedEvent } from "rettime";
//#region src/request-controller.d.ts
interface RequestControllerSource {
  passthrough(): void | Promise<void>;
  respondWith(response: Response): void | Promise<void>;
  errorWith(reason?: unknown): void | Promise<void>;
}
interface RequestControllerOptions {
  logger: Logger;
  requestId: string;
}
declare class RequestController {
  #private;
  protected readonly request: Request;
  protected readonly source: RequestControllerSource;
  protected readonly options?: RequestControllerOptions | undefined;
  static PENDING: 0;
  static PASSTHROUGH: 1;
  static RESPONSE: 2;
  static ERROR: 3;
  readyState: number;
  /**
   * A Promise that resolves when this controller handles a request.
   * See `controller.readyState` for more information on the handling result.
   */
  handled: Promise<void>;
  constructor(request: Request, source: RequestControllerSource, options?: RequestControllerOptions | undefined);
  /**
   * Perform this request as-is.
   */
  passthrough(): Promise<void>;
  /**
   * Respond to this request with the given `Response` instance.
   *
   * @example
   * controller.respondWith(new Response())
   * controller.respondWith(Response.json({ id }))
   * controller.respondWith(Response.error())
   */
  respondWith(response: Response): void;
  /**
   * Error this request with the given reason.
   *
   * @example
   * controller.errorWith()
   * controller.errorWith(new Error('Oops!'))
   * controller.errorWith({ message: 'Oops!'})
   */
  errorWith(reason?: unknown): void;
}
//#endregion
//#region src/events/http.d.ts
interface HttpRequestEventData {
  request: Request;
  requestId: string;
  initiator: unknown;
  controller: RequestController;
}
declare class HttpRequestEvent<DataType extends HttpRequestEventData = HttpRequestEventData> extends TypedEvent<DataType, void, 'request'> {
  request: Request;
  requestId: string;
  initiator: unknown;
  controller: RequestController;
  constructor(data: DataType);
}
type HttpResponseType = 'mock' | 'original';
interface HttpResponseEventData {
  response: Response;
  responseType: HttpResponseType;
  request: Request;
  requestId: string;
  initiator: unknown;
}
declare class HttpResponseEvent<DataType extends HttpResponseEventData = HttpResponseEventData> extends TypedEvent<DataType, void, 'response'> {
  response: Response;
  responseType: HttpResponseType;
  request: Request;
  requestId: string;
  initiator: unknown;
  constructor(data: DataType);
}
interface UnhandledHttpExceptionEventData {
  error: unknown;
  request: Request;
  requestId: string;
  initiator: unknown;
  controller: RequestController;
}
declare class UnhandledHttpException<DataType extends UnhandledHttpExceptionEventData = UnhandledHttpExceptionEventData> extends TypedEvent<DataType, void, 'unhandledException'> {
  error: unknown;
  request: Request;
  requestId: string;
  initiator: unknown;
  controller: RequestController;
  constructor(data: DataType);
}
type HttpRequestEventMap = {
  request: HttpRequestEvent;
  response: HttpResponseEvent;
  unhandledException: UnhandledHttpException;
};
//#endregion
export { RequestControllerSource as a, RequestController as i, HttpRequestEventMap as n, HttpResponseEvent as r, HttpRequestEvent as t };
//# sourceMappingURL=http-CB9rQ7i_.d.ts.map