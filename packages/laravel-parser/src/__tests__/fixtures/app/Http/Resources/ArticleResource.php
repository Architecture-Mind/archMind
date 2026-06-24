<?php

namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class ArticleResource extends JsonResource
{
    public function toArray($request): array
    {
        return [
            'id'     => $this->getKey(),
            'title'  => $this->title,
            'body'   => $this->body,
            'author' => AuthorResource::make($this->author),
            'tags'   => TagResource::collection($this->tags),
        ];
    }
}
