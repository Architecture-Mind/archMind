<?php

namespace App\Providers;

use Illuminate\Support\Facades\Route;
use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;

class RouteServiceProvider extends ServiceProvider
{
    public function boot()
    {
        Route::group([
            'middleware' => 'api',
            'prefix'     => 'api',
        ], function () {
            require base_path('routes/api.php');
        });

        Route::group([
            'middleware' => 'web',
        ], function () {
            require base_path('routes/web.php');
        });
    }
}
