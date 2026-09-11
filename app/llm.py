"""OpenAI 兼容 LLM 客户端（httpx，可注入 mock sender 用于测试）。"""
from typing import Any, Callable, Dict, Optional

import httpx

from .config import Config


class LLMError(Exception):
    pass


Sender = Callable[[Dict[str, Any]], Dict[str, Any]]


class LLMClient:
    def __init__(self, config: Config, sender: Optional[Sender] = None) -> None:
        self.config = config
        self._sender: Sender = sender or self._http_sender

    def chat(self, system: str, user: str,
             temperature: Optional[float] = None,
             max_tokens: Optional[int] = None) -> str:
        """两次调用（system+user），返回 assistant 文本。失败重试 config.llm_retry 次。"""
        payload: Dict[str, Any] = {
            "model": self.config.llm_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature if temperature is not None else self.config.llm_temperature,
            "max_tokens": max_tokens if max_tokens is not None else self.config.llm_max_output_tokens,
        }
        last_err: Optional[Exception] = None
        attempts = max(1, self.config.llm_retry + 1)
        for _ in range(attempts):
            try:
                resp = self._sender(payload)
                return self._extract_text(resp)
            except Exception as e:  # httpx 错误 / 结构错误都重试
                last_err = e
        raise LLMError(f"LLM 请求失败（已重试 {attempts - 1} 次）: {last_err}")

    @staticmethod
    def _extract_text(resp: Dict[str, Any]) -> str:
        try:
            choices = resp["choices"]
            content = choices[0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"LLM 响应结构异常: {e}") from e
        if not isinstance(content, str) or not content.strip():
            raise LLMError("LLM 响应内容为空")
        return content

    def _http_sender(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if self.config.llm_api_key:
            headers["Authorization"] = f"Bearer {self.config.llm_api_key}"
        timeout = httpx.Timeout(self.config.llm_timeout_seconds)
        with httpx.Client(timeout=timeout) as client:
            r = client.post(self.config.chat_completions_url, json=payload, headers=headers)
            r.raise_for_status()
            return r.json()
