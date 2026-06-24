<?php

namespace App\Jobs;

use App\Events\ArticleWasApproved;
use App\Models\Article;

class ApproveArticleJob
{
    public function __construct(private Article $article) {}

    public function handle(): void
    {
        $this->article->approved_at = now();
        $this->article->save();

        event(new ArticleWasApproved($this->article));
    }
}
