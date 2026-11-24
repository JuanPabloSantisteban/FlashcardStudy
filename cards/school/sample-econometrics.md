---
category: School
course: Econometrics
---

id: metrics-ols-estimator
topic: OLS
front: OLS estimator in matrix form
back: $$\hat\beta = (X'X)^{-1}X'y$$

===

id: metrics-omitted-variable-bias
topic: OLS
front: Omitted variable bias
back: If the true model is $y = \beta_0 + \beta_1 x + \beta_2 z + u$ and $z$ is left out, then
$$\operatorname{plim}\hat\beta_1 = \beta_1 + \beta_2\,\frac{\operatorname{Cov}(x,z)}{\operatorname{Var}(x)}$$
Bias exists only if $z$ affects $y$ **and** is correlated with $x$.
