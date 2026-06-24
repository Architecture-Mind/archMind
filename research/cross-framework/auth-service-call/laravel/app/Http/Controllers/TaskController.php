<?php

namespace App\Http\Controllers;

use App\Services\TaskService;

class TaskController extends Controller
{
    public function __construct(private TaskService $taskService) {}

    public function show(int $id)
    {
        return response()->json($this->taskService->findById($id));
    }
}
