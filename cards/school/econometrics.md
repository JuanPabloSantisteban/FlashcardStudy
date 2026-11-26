---
category: School
course: Econometrics
---

id: metrics-random-variable-realization
topic: Probability
front: In econometrics, what is the difference between an upper case letter like $X$ and a lower case $x$?
back: $X$ (upper case) is the **random variable**: the outcome before it happens. $x$ (lower case) is a **realization**: the particular value it takes once the outcome occurs.

**Example:** $X$ is the roll of a die before it's thrown; $x = 4$ is the number that comes up.

===

id: metrics-probability-of-realization
topic: Probability
front: In econometrics, what does $p_i \equiv \text{Prob}(X = x_i)$ mean?
back: $p_i$ is the **probability that the random variable $X$ takes the particular realization $x_i$**, one of its $k$ possible values $\{x_1, \dots, x_k\}$.

===

id: metrics-pdf-properties
topic: Probability
front: In econometrics, what are the properties of a probability density function (pdf) $f(x)$?
back:
- (i) $f(x) \geq 0$ for all $x$. The density is never negative.
- (ii) $\int_{-\infty}^{+\infty} f(x)\,dx = 1$. The total probability over all possible values is 1.
- (iii) $\int_a^b f(x)\,dx = \text{Prob}[a < X < b]$. The area under $f(x)$ between $a$ and $b$ is the probability that $X$ falls in that interval.

===

id: metrics-expected-value-population-mean
topic: Moments
front: In econometrics, what is another name for the expected value $E[X] = \sum_{i=1}^{k} x_i\,p_i$?
back: The **population mean**: $\mu = \sum_{i=1}^{k} x_i\,p_i = E[X]$. It is the probability-weighted average of the realizations $x_i$.

===

id: metrics-expected-value-definitions
topic: Moments
front: In econometrics, how is the expected value $E(X)$ defined for a discrete random variable, and for a continuous one?
back:
- **Discrete:** $E(X) \equiv \sum_{i=1}^{k} p_i\,x_i$. Each realization weighted by its probability, then summed.
- **Continuous:** $E(X) \equiv \int_{-\infty}^{+\infty} x\,f(x)\,dx$. The same idea, with the pdf $f(x)$ as the weights and an integral in place of the sum.

===

id: metrics-variance-definition
topic: Moments
front: In econometrics, what is the formal definition of the (population) variance of a random variable $X$?
back: $$Var(X) \equiv E\{[X - E(X)]^2\} = E(X^2) - [E(X)]^2$$
It is the expected squared deviation of $X$ from its mean, the usual measure of spread.
