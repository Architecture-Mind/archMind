<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use OpenTelemetry\API\Trace\SpanKind;
use OpenTelemetry\API\Trace\StatusCode;

/**
 * HTTP span instrumentation middleware for ArchMind OTLP collection.
 *
 * Emits one span per HTTP request with:
 *   - http.method, http.route, http.status_code
 *   - code.namespace (controller FQCN)
 *   - code.function  (controller method)
 *
 * Registration — add to $middlewareGroups['web'] and ['api'] in
 * app/Http/Kernel.php (Laravel ≤10) or bootstrap/app.php (Laravel 11+):
 *
 *   ->withMiddleware(function (Middleware $middleware) {
 *       $middleware->append(\App\Http\Middleware\ArchMindOtelMiddleware::class);
 *   })
 */
class ArchMindOtelMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        $tracer = app()->bound('archmind.tracer') ? app('archmind.tracer') : null;
        if (! $tracer) {
            return $next($request);
        }

        $route     = $request->route();
        $routePath = $route?->uri() ?? $request->path();
        $spanName  = $request->method() . ' /' . ltrim($routePath, '/');

        // Span 1: HTTP route span (infra-level)
        $httpSpan = $tracer->spanBuilder($spanName)
            ->setSpanKind(SpanKind::KIND_SERVER)
            ->setAttribute('http.method', $request->method())
            ->setAttribute('http.route',  '/' . ltrim($routePath, '/'))
            ->setAttribute('http.url',    $request->fullUrl())
            ->startSpan();

        try {
            $response = $next($request);
            $httpSpan->setAttribute('http.status_code', $response->getStatusCode());
            if ($response->getStatusCode() >= 500) {
                $httpSpan->setStatus(StatusCode::STATUS_ERROR);
            }

            // Route is resolved AFTER $next() in global middleware — get action here
            $resolvedRoute = $request->route();
            $action        = $resolvedRoute?->getActionName() ?? 'Closure';
            if (str_contains($action, '@')) {
                [$class, $method] = explode('@', $action, 2);
                // Span 2: Controller action span — correlatable by code.namespace/function
                $controllerSpan = $tracer->spanBuilder(class_basename($class) . '::' . $method)
                    ->setSpanKind(SpanKind::KIND_INTERNAL)
                    ->setAttribute('code.namespace', $class)
                    ->setAttribute('code.function',  $method)
                    ->setAttribute('http.route',     '/' . ltrim($routePath, '/'))
                    ->startSpan();
                $controllerSpan->end();
            } elseif ($action !== 'Closure') {
                $controllerSpan = $tracer->spanBuilder(class_basename($action) . '::__invoke')
                    ->setSpanKind(SpanKind::KIND_INTERNAL)
                    ->setAttribute('code.namespace', $action)
                    ->setAttribute('code.function',  '__invoke')
                    ->setAttribute('http.route',     '/' . ltrim($routePath, '/'))
                    ->startSpan();
                $controllerSpan->end();
            }

            return $response;
        } catch (\Throwable $e) {
            $httpSpan->setStatus(StatusCode::STATUS_ERROR, $e->getMessage());
            throw $e;
        } finally {
            $httpSpan->end();
        }
    }
}

