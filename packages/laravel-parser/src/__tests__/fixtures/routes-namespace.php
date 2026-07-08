<?php

use Illuminate\Support\Facades\Route;

// Module-style route registration (e.g. nwidart/laravel-modules): controllers
// referenced by bare string name are resolved under the group's namespace,
// not the App\Http\Controllers\ convention.
Route::namespace('Modules\Accounting\Http\Controllers')->group(function () {
    Route::get('/invoices', 'InvoiceController@index');
});

// Options-array group form: ['namespace' => '...']
Route::group(['namespace' => 'Modules\Billing\Http\Controllers'], function () {
    Route::get('/bills', 'BillController@index');
});

// No namespace group — falls back to the App\Http\Controllers\ convention.
Route::get('/health', 'HealthController@check');
