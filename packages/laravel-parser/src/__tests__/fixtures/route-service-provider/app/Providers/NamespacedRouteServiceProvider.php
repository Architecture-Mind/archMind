<?php

namespace App\Providers;

use Illuminate\Support\Facades\Route as Facade;
use Illuminate\Foundation\Support\Providers\RouteServiceProvider as Provider;

/**
 * Mirrors Akaunting's app/Providers/Route.php: a custom-named provider
 * (not literally "RouteServiceProvider.php") that wraps each route file in
 * a fluent ->namespace($this->namespace) chain resolved from a class-level
 * property, plus a literal-string namespace and an options-array namespace.
 */
class NamespacedRouteServiceProvider extends Provider
{
    protected $namespace = 'App\Http\Controllers';

    public function map()
    {
        Facade::prefix('{company_id}')
            ->middleware('admin')
            ->namespace($this->namespace)
            ->group(base_path('routes/admin.php'));

        Facade::prefix('api')
            ->middleware('api')
            ->namespace('App\Http\Controllers\Api')
            ->group(base_path('routes/api.php'));

        Facade::group(['namespace' => 'App\Http\Controllers\Web', 'middleware' => 'web'], function () {
            require base_path('routes/web.php');
        });
    }
}
