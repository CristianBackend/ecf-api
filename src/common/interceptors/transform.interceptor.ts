import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: Record<string, any>;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    // DGII-facing endpoints (/fe/...) must return raw XML, not the {success, data}
    // wrapper. Wrapping breaks the semilla and ARECF — DGII expects bare XML.
    const request = context.switchToHttp().getRequest();
    const requestUrl: string = request?.originalUrl ?? request?.url ?? '';
    if (requestUrl.includes('/fe/')) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        // If response already has success field, pass through
        if (data && typeof data === 'object' && 'success' in data) {
          return data;
        }

        // Extract meta if present
        if (data && typeof data === 'object' && 'data' in data && 'meta' in data) {
          return {
            success: true,
            data: data.data,
            meta: data.meta,
          };
        }

        return {
          success: true,
          data,
        };
      }),
    );
  }
}
